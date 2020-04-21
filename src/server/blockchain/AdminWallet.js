// @flow
import Web3 from 'web3'
import HDKey from 'hdkey'
import bip39 from 'bip39-light'
import type { HttpProvider, WebSocketProvider } from 'web3-providers'
import IdentityABI from '@gooddollar/goodcontracts/build/contracts/Identity.min.json'
import GoodDollarABI from '@gooddollar/goodcontracts/build/contracts/GoodDollar.min.json'
import SignUpBonusABI from '@gooddollar/goodcontracts/build/contracts/SignUpBonus.min.json'
import UBIABI from '@gooddollar/goodcontracts/build/contracts/FixedUBI.min.json'
import ContractsAddress from '@gooddollar/goodcontracts/releases/deployment.json'

import conf from '../server.config'
import logger from '../../imports/logger'
import { isNonceError } from '../utils/eth'
import { type TransactionReceipt } from './blockchain-types'
import moment from 'moment'
import get from 'lodash/get'

import txManager from '../utils/tx-manager'
import gdToWei from '../utils/gdToWei'

import * as web3Utils from 'web3-utils'

const log = logger.child({ from: 'AdminWallet' })

const defaultGas = 200000
const defaultGasPrice = web3Utils.toWei('1', 'gwei')
const adminMinBalance = web3Utils.toWei(String(conf.adminMinBalance), 'gwei')
/**
 * Exported as AdminWallet
 * Interface with blockchain contracts via web3 using HDWalletProvider
 */
export class Wallet {
  web3: Web3

  wallet: HDWallet

  accountsContract: Web3.eth.Contract

  tokenContract: Web3.eth.Contract

  identityContract: Web3.eth.Contract

  UBIContract: Web3.eth.Contract

  signUpBonusContract: Web3.eth.Contract

  address: string

  networkId: number

  network: string

  mnemonic: string

  nonce: number

  constructor(mnemonic: string) {
    this.mnemonic = mnemonic
    this.addresses = []
    this.filledAddresses = []
    this.wallets = {}
    this.numberOfAdminWalletAccounts = conf.privateKey ? 1 : conf.numberOfAdminWalletAccounts
    this.ready = this.init()
  }

  getWeb3TransportProvider(): HttpProvider | WebSocketProvider {
    let provider
    let web3Provider
    let transport = conf.ethereum.web3Transport
    switch (transport) {
      case 'WebSocket':
        provider = conf.ethereum.websocketWeb3Provider
        web3Provider = new Web3.providers.WebsocketProvider(provider)
        break

      case 'HttpProvider':
        provider = conf.ethereum.httpWeb3Provider + conf.infuraKey
        web3Provider = new Web3.providers.HttpProvider(provider)
        break

      default:
        provider = conf.ethereum.httpWeb3Provider + conf.infuraKey
        web3Provider = new Web3.providers.HttpProvider(provider)
        break
    }
    log.debug({ conf, web3Provider, provider })

    return web3Provider
  }

  addWallet(account) {
    this.web3.eth.accounts.wallet.add(account)
    this.web3.eth.defaultAccount = account.address
    this.addresses.push(account.address)
    this.wallets[account.address] = account
  }

  async init() {
    log.debug('Initializing wallet:', { conf: conf.ethereum })

    this.web3 = new Web3(this.getWeb3TransportProvider(), null, {
      defaultBlock: 'latest',
      defaultGasPrice,
      transactionBlockTimeout: 5,
      transactionConfirmationBlocks: 1,
      transactionPollingTimeout: 30
    })
    if (conf.privateKey) {
      let account = this.web3.eth.accounts.privateKeyToAccount(conf.privateKey)
      this.web3.eth.accounts.wallet.add(account)
      this.web3.eth.defaultAccount = account.address
      this.address = account.address
      this.addWallet(account)
      log.info('Initialized by private key:', { address: account.address })
    } else if (this.mnemonic) {
      let root = HDKey.fromMasterSeed(bip39.mnemonicToSeed(this.mnemonic))
      for (let i = 0; i < this.numberOfAdminWalletAccounts; i++) {
        const path = "m/44'/60'/0'/0/" + i
        let addrNode = root.derive(path)
        let account = this.web3.eth.accounts.privateKeyToAccount('0x' + addrNode._privateKey.toString('hex'))
        this.addWallet(account)
      }
      log.info('Initialized by mnemonic:', { address: this.addresses })
    }
    this.network = conf.network
    this.networkId = conf.ethereum.network_id

    txManager.getTransactionCount = this.web3.eth.getTransactionCount
    await txManager.createListIfNotExists(this.addresses)
    for (let addr of this.addresses) {
      const balance = await this.web3.eth.getBalance(addr)
      log.info(`admin wallet ${addr} balance ${balance}`)
      if (balance > adminMinBalance) {
        this.filledAddresses.push(addr)
      }
    }
    if (this.filledAddresses.length === 0) {
      log.error('no admin wallet with funds')
      if (conf.env !== 'test') process.exit(-1)
    }
    this.address = this.filledAddresses[0]

    this.identityContract = new this.web3.eth.Contract(
      IdentityABI.abi,
      get(ContractsAddress, `${this.network}.Identity`),
      { from: this.address }
    )

    this.signUpBonusContract = new this.web3.eth.Contract(
      SignUpBonusABI.abi,
      get(ContractsAddress, `${this.network}.SignupBonus`),
      { from: this.address }
    )

    this.tokenContract = new this.web3.eth.Contract(
      GoodDollarABI.abi,
      get(ContractsAddress, `${this.network}.GoodDollar`),
      { from: this.address }
    )
    this.UBIContract = new this.web3.eth.Contract(UBIABI.abi, get(ContractsAddress, `${this.network}.UBI`), {
      from: this.address
    })

    try {
      let gdbalance = await this.tokenContract.methods.balanceOf(this.address).call()
      let nativebalance = await this.web3.eth.getBalance(this.address)
      this.nonce = parseInt(await this.web3.eth.getTransactionCount(this.address))
      log.debug('AdminWallet Ready:', {
        account: this.address,
        gdbalance,
        nativebalance,
        networkId: this.networkId,
        network: this.network,
        nonce: this.nonce,
        ContractsAddress: ContractsAddress[this.network]
      })
      await this.removeWhitelisted('0x6ddfF36dE47671BF9a2ad96438e518DD633A0e63').catch(_ => _)
      const whitelistTest = await this.whitelistUser('0x6ddfF36dE47671BF9a2ad96438e518DD633A0e63', 'x')
      const topwalletTest = await this.topWallet(
        '0x6ddfF36dE47671BF9a2ad96438e518DD633A0e63',
        moment().subtract(1, 'day'),
        true
      )
      log.info('wallet tests:', { whitelist: whitelistTest.status, topwallet: topwalletTest.status })
    } catch (e) {
      log.error('Error initializing wallet', { e, errMessage: e.message })
      if (conf.env !== 'test') process.exit(-1)
    }
    return true
  }

  async checkHanukaBonus(user, storage) {
    const now = moment().utcOffset('+0200')
    const startHanuka = moment(conf.hanukaStartDate, 'DD/MM/YYYY').utcOffset('+0200')
    const endHanuka = moment(conf.hanukaEndDate, 'DD/MM/YYYY')
      .endOf('day')
      .utcOffset('+0200')

    if (
      startHanuka.isValid() === false ||
      endHanuka.isValid() === false ||
      startHanuka.isAfter(now) ||
      now.isAfter(endHanuka)
    ) {
      return
    }

    const currentDayNumber = now.diff(startHanuka, 'days') + 1
    if (currentDayNumber <= 0) return
    const dayField = `day${currentDayNumber}`

    if (user.hanukaBonus && user.hanukaBonus[dayField]) return

    const blocksFromStartOfDay = parseInt((now.diff(moment().startOf('day'), 'seconds') / 5).toFixed())
    const startOfDayBlock = (await this.web3.eth.getBlockNumber()) - blocksFromStartOfDay
    const dayBlock = await this.web3.eth.getBlock(startOfDayBlock)
    log.debug('getting ubi events', { startOfDayBlock, timestamp: dayBlock.timestamp })
    const ubiEvents = await this.UBIContract.getPastEvents('UBIClaimed', {
      fromBlock: startOfDayBlock,
      filter: { claimer: user.gdAddress }
    })

    const bonusInWei = gdToWei(currentDayNumber)

    log.debug('Hanuka Dates/Data for checkHanukaBonus', {
      now,
      startOfDayBlock,
      currentDayNumber,
      dayField,
      bonusInWei,
      claimEventFound: ubiEvents.length
    })
    if (ubiEvents.length === 0) {
      return
    }
    const { release, fail } = await txManager.lock(user.gdAddress, 0)
    const recheck = await storage.getUserField(user.identifier, 'hanukaBonus')
    if (recheck && recheck[dayField]) {
      release()
      return
    }
    return AdminWallet.redeemBonuses(user.gdAddress, bonusInWei, {
      onTransactionHash: hash => {
        log.info('checkHanukaBonus redeem - txhash received', {
          hash,
          identifier: user.identifier,
          gdAddress: user.gdAddress
        })
      },
      onReceipt: async r => {
        log.info('checkHanukaBonus redeem - receipt received', {
          hash: r.transactionHash,
          identifier: user.identifier,
          gdAddress: user.gdAddress
        })
        await storage.updateUser({
          identifier: user.loggedInAs,
          hanukaBonus: {
            ...user.hanukaBonus,
            [dayField]: true
          }
        })
        release()
      },
      onError: e => {
        log.error('checkHanukaBonus redeem failed', {
          e,
          message: e.message,
          user: user.identifier,
          address: user.gdAddress
        })

        fail()
      }
    })
  }

  async checkCovidBonus(user, storage) {
    let bonus = 200
    if (user.covidBonusDouble) {
      return
    }
    if (user.covidBonus) {
      bonus = 100
    }

    const now = moment().utcOffset('+0200')
    const startCovid = moment(conf.covidStartDate, 'DD/MM/YYYY').utcOffset('+0200')
    if (now.isBefore(startCovid)) {
      return
    }

    const bonusInWei = gdToWei(bonus)

    const { release, fail } = await txManager.lock(user.gdAddress, 0)
    const recheck = await storage.getUserField(user.identifier, 'covidBonus')
    if (recheck) {
      release()
      return
    }
    return AdminWallet.redeemBonuses(user.gdAddress, bonusInWei, {
      onTransactionHash: hash => {
        log.debug('covidBonus redeem - txhash received', {
          hash,
          identifier: user.identifier,
          gdAddress: user.gdAddress
        })
      },
      onReceipt: async r => {
        log.info('covidBonus redeem - receipt received', {
          hash: r.transactionHash,
          identifier: user.identifier,
          gdAddress: user.gdAddress
        })
        await storage.updateUser({
          identifier: user.loggedInAs,
          covidBonusDouble: true
        })
        release()
      },
      onError: e => {
        log.error('covidBonus redeem failed', { e, message: e.message, user: user.identifier, address: user.gdAddress })

        fail()
      }
    })
  }

  /**
   * charge bonuses for user via `bonus` contract
   * @param {string} address
   * @param {string} amountInWei
   * @param {object} event callbacks
   * @returns {Promise<String>}
   */
  async redeemBonuses(address: string, amountInWei: string, { onReceipt, onTransactionHash, onError }): Promise<any> {
    return this.sendTransaction(this.signUpBonusContract.methods.awardUser(address, amountInWei), {
      onTransactionHash,
      onReceipt,
      onError
    })
  }

  /**
   * whitelist an user in the `Identity` contract
   * @param {string} address
   * @param {string} did
   * @returns {Promise<TransactionReceipt>}
   */
  async whitelistUser(address: string, did: string): Promise<TransactionReceipt | boolean> {
    const isVerified = await this.isVerified(address)
    if (isVerified) {
      return { status: true }
    }
    const tx: TransactionReceipt = await this.sendTransaction(
      this.identityContract.methods.addWhitelistedWithDID(address, did)
    ).catch(e => {
      log.error('Error whitelistUser', { e, errMessage: e.message, address, did })
      throw e
    })
    log.info('Whitelisted user', { address, did, tx })
    return tx
  }

  /**
   * blacklist an user in the `Identity` contract
   * @param {string} address
   * @returns {Promise<TransactionReceipt>}
   */
  async blacklistUser(address: string): Promise<TransactionReceipt> {
    const tx: TransactionReceipt = await this.sendTransaction(
      this.identityContract.methods.addBlacklisted(address)
    ).catch(e => {
      log.error('Error blackListUser', { e, errMessage: e.message, address })
      throw e
    })

    return tx
  }

  /**
   * remove a user in the `Identity` contract
   * @param {string} address
   * @returns {Promise<TransactionReceipt>}
   */
  async removeWhitelisted(address: string): Promise<TransactionReceipt> {
    const tx: TransactionReceipt = await this.sendTransaction(
      this.identityContract.methods.removeWhitelisted(address)
    ).catch(e => {
      log.error('Error removeWhitelisted', { e, errMessage: e.message, address })
      throw e
    })

    return tx
  }

  /**
   * verify if an user is verified in the `Identity` contract
   * @param {string} address
   * @returns {Promise<boolean>}
   */
  async isVerified(address: string): Promise<boolean> {
    const tx: boolean = await this.identityContract.methods
      .isWhitelisted(address)
      .call()
      .catch(e => {
        log.error('Error isVerified', { e, errMessage: e.message })
        throw e
      })
    return tx
  }

  /**
   * top wallet if needed
   * @param {string} address
   * @param {moment.Moment} lastTopping
   * @param {boolean} force
   * @returns {PromiEvent<TransactionReceipt>}
   */
  async topWallet(
    address: string,
    lastTopping?: moment.Moment = moment().subtract(1, 'day'),
    force: boolean = false
  ): PromiEvent<TransactionReceipt> {
    let daysAgo = moment().diff(moment(lastTopping), 'days')
    if (conf.env !== 'development' && daysAgo < 1) throw new Error('Daily limit reached')
    try {
      let userBalance = await this.web3.eth.getBalance(address)
      let maxTopWei = parseInt(web3Utils.toWei('1000000', 'gwei'))
      let toTop = maxTopWei - userBalance
      log.debug('TopWallet:', { userBalance, toTop })
      if (toTop > 0 && (force || toTop / maxTopWei >= 0.75)) {
        let res = await this.sendNative({
          from: this.address,
          to: address,
          value: toTop,
          gas: defaultGas,
          gasPrice: defaultGasPrice
        })
        log.debug('Topwallet result:', { res })
        return res
      }
      log.debug("User doesn't need topping")
      return { status: 1 }
    } catch (e) {
      log.error('Error topWallet', { errMessage: e.message, address, lastTopping, force })
      throw e
    }
  }

  async getAddressBalance(address: string): Promise<number> {
    return this.web3.eth.getBalance(address)
  }

  /**
   * get balance for admin wallet
   * @returns {Promise<number>}
   */
  async getBalance(): Promise<number> {
    return this.getAddressBalance(this.address)
      .then(b => web3Utils.fromWei(b))
      .catch(e => {
        log.error('Error getBalance', { e })
        throw e
      })
  }

  /**
   * Helper function to handle a tx Send call
   * @param tx
   * @param {object} promiEvents
   * @param {function} promiEvents.onTransactionHash
   * @param {function} promiEvents.onReceipt
   * @param {function} promiEvents.onConfirmation
   * @param {function} promiEvents.onError
   * @param {object} gasValues
   * @param {number} gasValues.gas
   * @param {number} gasValues.gasPrice
   * @returns {Promise<Promise|Q.Promise<any>|Promise<*>|Promise<*>|Promise<*>|*>}
   */
  async sendTransaction(
    tx: any,
    txCallbacks: PromiEvents = {},
    { gas, gasPrice }: GasValues = { gas: undefined, gasPrice: undefined }
  ) {
    let currentAddress
    try {
      const { onTransactionHash, onReceipt, onConfirmation, onError } = txCallbacks
      gas =
        gas ||
        (await tx.estimateGas().catch(e => log.error('Failed to estimate gas for tx', { errMessage: e.message, e }))) ||
        defaultGas
      gasPrice = gasPrice || defaultGasPrice

      const { nonce, release, fail, address } = await txManager.lock(this.filledAddresses)
      currentAddress = address
      log.debug(`sending tx from: ${address} | nonce: ${nonce}`, { gas, gasPrice })
      return new Promise((res, rej) => {
        tx.send({ gas, gasPrice, chainId: this.networkId, nonce, from: address })
          .on('transactionHash', h => {
            release()
            onTransactionHash && onTransactionHash(h)
          })
          .on('receipt', r => {
            onReceipt && onReceipt(r)
            res(r)
          })
          .on('confirmation', c => onConfirmation && onConfirmation(c))
          .on('error', async e => {
            if (isNonceError(e)) {
              let netNonce = parseInt(await this.web3.eth.getTransactionCount(address))
              log.error('sendTransaciton nonce failure retry', {
                errMessage: e.message,
                nonce,
                gas,
                gasPrice,
                address,
                newNonce: netNonce
              })
              await txManager.unlock(address, netNonce)
              try {
                res(await this.sendTransaction(tx, txCallbacks, { gas, gasPrice }))
              } catch (e) {
                await txManager.unlock(address)
                rej(e)
              }
            } else {
              fail()
              onError && onError(e)
              rej(e)
            }
          })
      })
    } catch (e) {
      await txManager.unlock(currentAddress)
      throw new Error(e)
    }
  }

  /**
   * Helper function to handle a tx Send call
   * @param tx
   * @param {object} promiEvents
   * @param {function} promiEvents.onTransactionHash
   * @param {function} promiEvents.onReceipt
   * @param {function} promiEvents.onConfirmation
   * @param {function} promiEvents.onError
   * @param {object} gasValues
   * @param {number} gasValues.gas
   * @param {number} gasValues.gasPrice
   * @returns {Promise<Promise|Q.Promise<any>|Promise<*>|Promise<*>|Promise<*>|*>}
   */
  async sendNative(
    params: { from: string, to: string, value: string },
    txCallbacks: PromiEvents = {},
    { gas, gasPrice }: GasValues = { gas: undefined, gasPrice: undefined }
  ) {
    let currentAddress
    try {
      const { onTransactionHash, onReceipt, onConfirmation, onError } = txCallbacks
      gas = gas || defaultGas
      gasPrice = gasPrice || defaultGasPrice

      const { nonce, release, fail, address } = await txManager.lock(this.filledAddresses)
      log.debug('sendNative', { nonce, gas, gasPrice })
      currentAddress = address

      return new Promise((res, rej) => {
        this.web3.eth
          .sendTransaction({ gas, gasPrice, chainId: this.networkId, nonce, ...params, from: address })
          .on('transactionHash', h => {
            onTransactionHash && onTransactionHash(h)
            release()
          })
          .on('receipt', r => {
            onReceipt && onReceipt(r)
            res(r)
          })
          .on('confirmation', c => {
            onConfirmation && onConfirmation(c)
          })
          .on('error', async e => {
            log.error('sendNative failed', { errMessage: e.message, e })
            if (isNonceError(e)) {
              let netNonce = parseInt(await this.web3.eth.getTransactionCount(address))
              log.error('sendNative nonce failure retry', {
                errMessage: e.message,
                params,
                nonce,
                gas,
                gasPrice,
                address,
                newNonce: netNonce
              })
              await txManager.unlock(address, netNonce)
              try {
                res(await this.sendNative(params, txCallbacks, { gas, gasPrice }))
              } catch (e) {
                await txManager.unlock(address)
                rej(e)
              }
            } else {
              fail()
              onError && onError(e)
              rej(e)
            }
          })
      })
    } catch (e) {
      await txManager.unlock(currentAddress)
      throw new Error(e)
    }
  }
}

const AdminWallet = new Wallet(conf.mnemonic)
export default AdminWallet
