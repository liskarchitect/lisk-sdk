/*
 * Copyright © 2018 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 */

'use strict';

const {
	Status: TransactionStatus,
	TransactionError,
} = require('@liskhq/lisk-transactions');
const roundInformation = require('../logic/rounds_information');
const StateStore = require('../logic/state_store');
const slots = require('../helpers/slots');
const checkTransactionExceptions = require('../logic/check_transaction_against_exceptions.js');

let library;

const updateTransactionResponseForExceptionTransactions = (
	unprocessableTransactionResponses,
	transactions
) => {
	const unprocessableTransactionAndResponsePairs = unprocessableTransactionResponses.map(
		unprocessableTransactionResponse => ({
			transactionResponse: unprocessableTransactionResponse,
			transaction: transactions.find(
				transaction => transaction.id === unprocessableTransactionResponse.id
			),
		})
	);

	const exceptionTransactionsAndResponsePairs = unprocessableTransactionAndResponsePairs.filter(
		({ transactionResponse, transaction }) =>
			checkTransactionExceptions.checkIfTransactionIsException(
				transactionResponse,
				transaction
			)
	);

	// Update the transaction response for exception transactions
	exceptionTransactionsAndResponsePairs.forEach(({ transactionResponse }) => {
		transactionResponse.status = TransactionStatus.OK;
		transactionResponse.errors = [];
	});
};

class ProcessTransactions {
	constructor(cb, scope) {
		library = {
			logger: scope.components.logger,
			storage: scope.components.storage,
		};
		setImmediate(cb, null, this);
	}

	// eslint-disable-next-line class-methods-use-this
	validateTransactions(transactions) {
		const transactionsResponses = transactions.map(transaction =>
			transaction.validate()
		);

		const invalidTransactionResponses = transactionsResponses.filter(
			transactionResponse => transactionResponse.status !== TransactionStatus.OK
		);
		updateTransactionResponseForExceptionTransactions(
			invalidTransactionResponses,
			transactions
		);

		return {
			transactionsResponses,
		};
	}

	// eslint-disable-next-line class-methods-use-this
	async checkPersistedTransactions(transactions) {
		const confirmedTransactions = await library.storage.entities.Transaction.get(
			{
				id_in: transactions.map(transaction => transaction.id),
			}
		);

		const persistedTransactionIds = confirmedTransactions.map(
			transaction => transaction.id
		);
		const persistedTransactions = transactions.filter(transaction =>
			persistedTransactionIds.includes(transaction.id)
		);
		const unpersistedTransactions = transactions.filter(
			transaction => !persistedTransactionIds.includes(transaction.id)
		);
		const transactionsResponses = [
			...unpersistedTransactions.map(transaction => ({
				id: transaction.id,
				status: TransactionStatus.OK,
				errors: [],
			})),
			...persistedTransactions.map(transaction => ({
				id: transaction.id,
				status: TransactionStatus.FAIL,
				errors: [
					new TransactionError(
						`Transaction is already confirmed: ${transaction.id}`,
						transaction.id,
						'.id'
					),
				],
			})),
		];

		return {
			transactionsResponses,
		};
	}

	// eslint-disable-next-line class-methods-use-this
	async applyTransactions(transactions, tx = undefined) {
		// Get data required for verifying transactions
		library.logger.info(
			{ meta: { action: 'applyTransactionsStart' } },
			'Applying transaction started'
		);
		const stateStore = new StateStore(library.storage, {
			mutate: true,
			tx,
		});

		await Promise.all(transactions.map(t => t.prepare(stateStore)));

		const transactionsResponses = transactions.map(transaction => {
			const transactionResponse = transaction.apply(stateStore);
			roundInformation.apply(stateStore, transaction);
			stateStore.transaction.add(transaction);
			return transactionResponse;
		});

		const unappliableTransactionsResponse = transactionsResponses.filter(
			transactionResponse => transactionResponse.status !== TransactionStatus.OK
		);

		updateTransactionResponseForExceptionTransactions(
			unappliableTransactionsResponse,
			transactions
		);
		library.logger.info(
			{ meta: { action: 'applyTransactionsEnd' } },
			'Applying transaction ended'
		);

		return {
			transactionsResponses,
			stateStore,
		};
	}

	// eslint-disable-next-line class-methods-use-this
	async undoTransactions(transactions, tx = undefined) {
		// Get data required for verifying transactions
		const stateStore = new StateStore(library.storage, {
			mutate: true,
			tx,
		});

		await Promise.all(transactions.map(t => t.prepare(stateStore)));

		const transactionsResponses = transactions.map(transaction => {
			const transactionResponse = transaction.undo(stateStore);
			roundInformation.undo(stateStore, transaction);
			return transactionResponse;
		});

		const unundoableTransactionsResponse = transactionsResponses.filter(
			transactionResponse => transactionResponse.status !== TransactionStatus.OK
		);

		updateTransactionResponseForExceptionTransactions(
			unundoableTransactionsResponse,
			transactions
		);

		return {
			transactionsResponses,
			stateStore,
		};
	}

	// eslint-disable-next-line class-methods-use-this
	async verifyTransactions(transactions) {
		// Get data required for verifying transactions
		library.logger.info(
			{ meta: { action: 'verifyTransactionsStarted' } },
			'Verify transaction started'
		);
		const stateStore = new StateStore(library.storage, {
			mutate: false,
		});

		await Promise.all(transactions.map(t => t.prepare(stateStore)));

		const transactionsResponses = transactions.map(transaction => {
			stateStore.createSnapshot();
			const transactionResponse = transaction.apply(stateStore);
			if (slots.getSlotNumber(transaction.timestamp) > slots.getSlotNumber()) {
				transactionResponse.status = 0;
				transactionResponse.errors.push(
					new TransactionError(
						'Invalid transaction timestamp. Timestamp is in the future',
						transaction.id,
						'.timestamp'
					)
				);
			}
			stateStore.restoreSnapshot();
			return transactionResponse;
		});

		const unverifiableTransactionsResponse = transactionsResponses.filter(
			transactionResponse => transactionResponse.status !== TransactionStatus.OK
		);

		updateTransactionResponseForExceptionTransactions(
			unverifiableTransactionsResponse,
			transactions
		);
		library.logger.info(
			{ meta: { action: 'verifyTransactionsEnd' } },
			'Verify transaction End'
		);

		return {
			transactionsResponses,
		};
	}

	// eslint-disable-next-line class-methods-use-this
	async processSignature(transaction, signature) {
		// Get data required for processing signature
		library.logger.info(
			{ meta: { action: 'process signature Transactions', transaction } },
			'process signature transaction start'
		);
		const stateStore = new StateStore(library.storage, {
			mutate: false,
		});
		await transaction.prepare(stateStore);
		// Add multisignature to transaction and process
		return transaction.addMultisignature(stateStore, signature);
	}
}

module.exports = ProcessTransactions;
