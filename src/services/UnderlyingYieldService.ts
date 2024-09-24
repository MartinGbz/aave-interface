import { AaveV2Ethereum, MiscEthereum } from '@bgd-labs/aave-address-book';
import { Provider } from '@ethersproject/providers';
import { Contract, EventFilter } from 'ethers';
import { formatUnits } from 'ethers/lib/utils';
import { FORK_ENABLED } from 'src/utils/marketsAndNetworksConfig';

import {
  cbEthOracle,
  etherfiLiquidityPool,
  rocketNetworkBalancesKey,
  rocketStorage,
  staderLabsOracle,
} from './UnderlyingYieldAddressesConfig';

export interface UnderlyingAPYs {
  [key: string]: number | null;
}

const DAY_IN_SECONDS = 60 * 60 * 24;
const YEAR_IN_SECONDS = 365 * DAY_IN_SECONDS;

const BLOCKS_A_DAY = DAY_IN_SECONDS / 12; // assume 12s block time

const RAY_PRECISION = 27;
const WAD_PRECISION = 18;

const EVENTS_PERIOD_DAYS = 7; // 1 week

const aprToApy = (apr: number, compund: number) => {
  return (1 + apr / compund) ** compund - 1;
};

const getApyFromRates = (
  latestRate: number,
  previousRate: number,
  duration: number,
  compound: number
): number => {
  const ratio = latestRate / previousRate - 1;

  // cross product
  const apr = (ratio * YEAR_IN_SECONDS) / duration;

  return aprToApy(Number(apr), compound);
};

type LstRate = {
  rate: number;
  timestamp: number;
};

const getApyFromLstRates = (
  latestExchange: LstRate,
  previousExchange: LstRate,
  compound: number
) => {
  const timeBetweenExchanges = latestExchange.timestamp - previousExchange.timestamp;
  return getApyFromRates(
    latestExchange.rate,
    previousExchange.rate,
    timeBetweenExchanges,
    compound
  );
};

export class UnderlyingYieldService {
  constructor(private readonly getProvider: (chainId: number) => Provider) {}

  async getUnderlyingAPYs(): Promise<UnderlyingAPYs> {
    const provider = this.getProvider(1);
    const currentBlockNumber = await provider.getBlockNumber();

    const stethAPY = await this.getStethAPY(provider, currentBlockNumber);
    const sdaiAPY = await this.getSdaiAPY(provider);
    const rethAPY = await this.getRethAPY(provider, currentBlockNumber);
    const ethxAPY = await this.getEthxAPY(provider, currentBlockNumber);
    const cbethAPY = await this.getCbethAPY(provider, currentBlockNumber);
    const weethAPY = await this.getWeethAPY(provider, currentBlockNumber);

    return {
      wstETH: stethAPY,
      sDAI: sdaiAPY,
      rETH: rethAPY,
      ETHx: ethxAPY,
      cbETH: cbethAPY,
      weETH: weethAPY,
    };
  }

  getStethAPY = async (provider: Provider, currentBlockNumber: number) => {
    const getApyFromApi = async () => {
      console.log('Warning: Fetching stETH APY from API');
      const res = await fetch('https://eth-api.lido.fi/v1/protocol/steth/apr/last');
      const resParsed: {
        data: {
          timeUnix: number;
          apr: number;
        };
        meta: {
          symbol: string;
          address: string;
          chainId: number;
        };
      } = await res.json();
      const apy = aprToApy(Number(resParsed.data.apr), 365);
      return apy;
    };

    const abi = [
      {
        anonymous: false,
        inputs: [
          { indexed: true, name: 'reportTimestamp', type: 'uint256' },
          { indexed: false, name: 'timeElapsed', type: 'uint256' },
          { indexed: false, name: 'preTotalShares', type: 'uint256' },
          { indexed: false, name: 'preTotalEther', type: 'uint256' },
          { indexed: false, name: 'postTotalShares', type: 'uint256' },
          { indexed: false, name: 'postTotalEther', type: 'uint256' },
          { indexed: false, name: 'sharesMintedAsFees', type: 'uint256' },
        ],
        name: 'TokenRebased',
        type: 'event',
      },
    ];

    const contract = new Contract(AaveV2Ethereum.ASSETS.stETH.UNDERLYING, abi); // stETH token
    const connectedContract = contract.connect(provider);

    const events = await this.fetchEventsInBatches({
      connectedContract,
      eventFilter: connectedContract.filters.TokenRebased(),
      fromBlock: currentBlockNumber - BLOCKS_A_DAY * EVENTS_PERIOD_DAYS,
      toBlock: currentBlockNumber,
    });

    const latestEvent = events.length === 0 ? null : events[events.length - 1];

    if (latestEvent && latestEvent.args) {
      // computation formula: https://docs.lido.fi/integrations/api#last-lido-apr-for-steth // <=> (post-pre)/pre <=> (post/pre)-1
      const preShareRate = latestEvent.args['preTotalEther'] / latestEvent.args['preTotalShares'];
      const postShareRate =
        latestEvent.args['postTotalEther'] / latestEvent.args['postTotalShares'];
      return getApyFromRates(postShareRate, preShareRate, latestEvent.args['timeElapsed'], 365); // stEth rebased daily: https://help.lido.fi/en/articles/5230610-what-is-steth
    } else {
      return await getApyFromApi();
    }
  };

  getSdaiAPY = async (provider: Provider) => {
    const abi = [
      {
        constant: true,
        inputs: [],
        name: 'dsr',
        outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
    ];

    const contract = new Contract(MiscEthereum.sDAI_POT, abi); // Maker DSR Pot (MCD Pot)
    const connectedContract = contract.connect(provider);

    const dsr = await connectedContract.dsr();

    const dsrFormated = formatUnits(dsr, RAY_PRECISION);

    // Inspired from DeFi LLama yield server: https://github.com/DefiLlama/yield-server/blob/master/src/adaptors/makerdao/index.js
    const apy = Number(dsrFormated) ** YEAR_IN_SECONDS - 1;

    return apy;
  };

  getRethAPY = async (provider: Provider, currentBlockNumber: number) => {
    const getApyFromApi = async () => {
      console.log('Warning: Fetching rETH APY from API');
      // based on 7 day average
      const res = await fetch('https://api.rocketpool.net/api/apr');
      const resParsed: {
        yearlyAPR: string;
      } = await res.json();
      return aprToApy(Number(resParsed.yearlyAPR) / 100, 365);
    };

    const rocketStorageAbi = [
      {
        inputs: [{ internalType: 'bytes32', name: '_key', type: 'bytes32' }],
        name: 'getAddress',
        outputs: [{ internalType: 'address', name: 'r', type: 'address' }],
        stateMutability: 'view',
        type: 'function',
      },
    ];

    const rocketStorageContract = new Contract(rocketStorage, rocketStorageAbi);
    const rocketStorageConnectedContract = rocketStorageContract.connect(provider);
    const rocketNetworkBalancesAddress = await rocketStorageConnectedContract.getAddress(
      rocketNetworkBalancesKey
    );

    const abi = [
      {
        anonymous: false,
        inputs: [
          { indexed: true, internalType: 'uint256', name: 'block', type: 'uint256' },
          { indexed: false, internalType: 'uint256', name: 'slotTimestamp', type: 'uint256' },
          { indexed: false, internalType: 'uint256', name: 'totalEth', type: 'uint256' },
          { indexed: false, internalType: 'uint256', name: 'stakingEth', type: 'uint256' },
          { indexed: false, internalType: 'uint256', name: 'rethSupply', type: 'uint256' },
          { indexed: false, internalType: 'uint256', name: 'blockTimestamp', type: 'uint256' },
        ],
        name: 'BalancesUpdated',
        type: 'event',
      },
    ];

    const contract = new Contract(rocketNetworkBalancesAddress, abi);
    const connectedContract = contract.connect(provider);
    const events = await this.fetchEventsInBatches({
      connectedContract,
      eventFilter: connectedContract.filters.BalancesUpdated(),
      fromBlock: currentBlockNumber - BLOCKS_A_DAY * EVENTS_PERIOD_DAYS,
      toBlock: currentBlockNumber,
    });

    const rates = events
      .map((event) => {
        if (!event.args || !event.args['totalEth'] || !event.args['rethSupply']) return null;
        return {
          rate: event.args['totalEth'] / event.args['rethSupply'],
          timestamp: event.args['blockTimestamp'],
        };
      })
      .filter((rate) => rate !== null) as LstRate[];
    if (rates === null || rates.length < 2) {
      return await getApyFromApi();
    } else {
      const apy = getApyFromLstRates(rates[rates.length - 1], rates[0], 365); // rewards are distributed approximately every 24 hours: (source: https://docs.rocketpool.net/guides/staking/overview#the-reth-token)
      return apy;
    }
  };

  getEthxAPY = async (provider: Provider, currentBlockNumber: number) => {
    const getApyFromApi = async () => {
      console.log('Warning: Fetching ETHx APY from API');
      const res = await fetch('https://universe.staderlabs.com/eth/apy');
      const resParsed: {
        value: number;
      } = await res.json();
      return resParsed.value / 100;
    };

    const abi = [
      {
        anonymous: false,
        inputs: [
          { indexed: false, internalType: 'uint256', name: 'block', type: 'uint256' },
          { indexed: false, internalType: 'uint256', name: 'totalEth', type: 'uint256' },
          { indexed: false, internalType: 'uint256', name: 'ethxSupply', type: 'uint256' },
          { indexed: false, internalType: 'uint256', name: 'time', type: 'uint256' },
        ],
        name: 'ExchangeRateUpdated',
        type: 'event',
      },
    ];

    const contract = new Contract(staderLabsOracle, abi); // Stader Labs Oracle
    const connectedContract = contract.connect(provider);
    const events = await this.fetchEventsInBatches({
      connectedContract,
      eventFilter: connectedContract.filters.ExchangeRateUpdated(),
      fromBlock: currentBlockNumber - BLOCKS_A_DAY * EVENTS_PERIOD_DAYS,
      toBlock: currentBlockNumber,
    });

    const rates = events
      .map((event) => {
        if (!event.args || !event.args['totalEth'] || !event.args['ethxSupply']) return null;
        return {
          rate: event.args['totalEth'] / event.args['ethxSupply'],
          timestamp: event.args['time'],
        };
      })
      .filter((rate) => rate !== null) as LstRate[];
    if (rates === null || rates.length < 2) {
      return await getApyFromApi();
    } else {
      const apy = getApyFromLstRates(rates[rates.length - 1], rates[0], 365); // rewards seems to be distributed every 24 hours
      return apy;
    }
  };

  getCbethAPY = async (provider: Provider, currentBlockNumber: number) => {
    const abi = [
      {
        anonymous: false,
        inputs: [
          { indexed: true, internalType: 'address', name: 'oracle', type: 'address' },
          { indexed: false, internalType: 'uint256', name: 'newExchangeRate', type: 'uint256' },
        ],
        name: 'ExchangeRateUpdated',
        type: 'event',
      },
    ];

    const contract = new Contract(cbEthOracle, abi); // cbETH Oracle
    const connectedContract = contract.connect(provider);
    const events = await this.fetchEventsInBatches({
      connectedContract,
      eventFilter: connectedContract.filters.ExchangeRateUpdated(),
      fromBlock: currentBlockNumber - BLOCKS_A_DAY * EVENTS_PERIOD_DAYS,
      toBlock: currentBlockNumber,
    });

    if (events && events.length > 2) {
      const lastestEventArgs = events[events.length - 1].args;
      const previousEventArgs = events[0].args;
      if (lastestEventArgs && previousEventArgs) {
        const latestEventBlock = await provider.getBlock(events[events.length - 1].blockNumber);
        const previousEventBlock = await provider.getBlock(events[0].blockNumber);
        const apy = getApyFromLstRates(
          {
            rate: Number(formatUnits(lastestEventArgs['newExchangeRate'], WAD_PRECISION)),
            timestamp: latestEventBlock.timestamp,
          },
          {
            rate: Number(formatUnits(previousEventArgs['newExchangeRate'], WAD_PRECISION)),
            timestamp: previousEventBlock.timestamp,
          },
          365 // rewards seems to be distributed every 24 hours
        );
        return apy;
      } else {
        return 0;
      }
    } else {
      return 0;
    }
  };

  getWeethAPY = async (provider: Provider, currentBlockNumber: number) => {
    const getApyFromApi = async () => {
      console.log('Warning: Fetching weETH APY from API');
      const res = await fetch('https://www.etherfi.bid/api/etherfi/apr');
      const resParsed: {
        sucess: boolean;
        latest_aprs: string[];
      } = await res.json();
      if (!resParsed.sucess) return 0;
      if (resParsed.latest_aprs.length === 0) return 0;
      return aprToApy(
        Number(resParsed.latest_aprs[resParsed.latest_aprs.length - 1]) / 100 / 100,
        365 * 4
      );
    };

    const abi = [
      {
        anonymous: false,
        inputs: [
          { indexed: false, internalType: 'uint256', name: 'totalEthLocked', type: 'uint256' },
          { indexed: false, internalType: 'uint256', name: 'totalEEthShares', type: 'uint256' },
        ],
        name: 'Rebase',
        type: 'event',
      },
    ];
    const contract = new Contract(etherfiLiquidityPool, abi); // Etherfi LiquidityPool
    const connectedContract = contract.connect(provider);
    const events = await this.fetchEventsInBatches({
      connectedContract,
      eventFilter: connectedContract.filters.Rebase(),
      fromBlock: currentBlockNumber - BLOCKS_A_DAY * EVENTS_PERIOD_DAYS,
      toBlock: currentBlockNumber,
    });

    if (events && events.length > 2) {
      const lastestEventArgs = events[events.length - 1].args;
      const previousEventArgs = events[0].args;
      if (lastestEventArgs && previousEventArgs) {
        const latestEventBlock = await provider.getBlock(events[events.length - 1].blockNumber);
        const previousEventBlock = await provider.getBlock(events[0].blockNumber);
        const latestEventRate =
          lastestEventArgs['totalEthLocked'] / lastestEventArgs['totalEEthShares'];
        const previousEventRate =
          previousEventArgs['totalEthLocked'] / previousEventArgs['totalEEthShares'];
        const apy = getApyFromLstRates(
          {
            rate: latestEventRate,
            timestamp: latestEventBlock.timestamp,
          },
          {
            rate: previousEventRate,
            timestamp: previousEventBlock.timestamp,
          },
          365 * 4 // rebase are approximately 4 times a day
        );
        return apy;
      } else {
        return await getApyFromApi();
      }
    } else {
      return await getApyFromApi();
    }
  };

  fetchEventsInBatches = async (parameters: {
    connectedContract: Contract;
    eventFilter: EventFilter;
    fromBlock: number;
    toBlock: number;
    blockRange?: number;
  }) => {
    const { connectedContract, eventFilter, fromBlock, toBlock } = parameters;

    let blockRange;

    if (parameters.blockRange) {
      blockRange = parameters.blockRange;
    } else if (FORK_ENABLED) {
      blockRange = 1000;
    } else {
      blockRange = BLOCKS_A_DAY * EVENTS_PERIOD_DAYS + 1;
    }

    let startBlock = fromBlock;

    const allEvents = [];

    while (startBlock <= toBlock) {
      const nextBlock = startBlock + blockRange - 1;
      const endBlock = nextBlock < toBlock ? nextBlock : toBlock;
      const events = await connectedContract.queryFilter(eventFilter, startBlock, endBlock);
      allEvents.push(...events);
      startBlock = endBlock + 1;
    }

    return allEvents;
  };
}
