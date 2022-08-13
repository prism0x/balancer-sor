/* eslint-disable prettier/prettier */
// import { SOR, SwapInfo, SwapTypes } from '../../src';
import * as fs from 'fs';
import { getBestPaths } from '../../src/router';
import {
    NewPath,
    PoolFilter,
    RouteProposer,
    // SOR,
    SubgraphPoolBase,
    Swap,
    SwapInfo,
    SwapOptions,
    SwapTypes,
} from '../../src';
import { BigNumber, parseFixed } from '@ethersproject/bignumber';
// import cloneDeep from 'lodash.clonedeep';
import { isSameAddress } from '../../src/utils';
import { SorConfig } from '../../src';
import { formatSwaps } from '../../src/formatSwaps';
import { BigNumber as OldBigNumber } from '../../src/utils/bignumber';
import { ADDRESSES, Network } from './constants';
import { sanitizePoolData } from './helper';

// import { default as pools } from '../../pools.json';
import { Zero } from '@ethersproject/constants';
import cloneDeep from 'lodash.clonedeep';
import { EMPTY_SWAPINFO } from '../../src/constants';

import { Command } from 'commander';

const program = new Command();
program
    .name('router-profiling')
    .description('Balancer SOR script to compare different routing engines')
    .requiredOption(
        '-p, --pools <poolsJSON>',
        'JSON file that contains pool information.'
    )
    .requiredOption('-i, --tokenIn <tokenIn>', 'Address of the input token.')
    .requiredOption('-o, --tokenOut <tokenOut>', 'Address of the output token.')
    .requiredOption('-q, --quantity <quantity>', 'Swap quantity.')
    .requiredOption('-t, --type <swapType>', 'Swap type.');
program.parse();
const args = program.opts();

const pools = JSON.parse(fs.readFileSync(args.pools, 'utf8'));

// const swapType = <SwapTypes> SwapTypes[args.type];
let swapType;
if (args.type === 'SwapExactIn') {
    swapType = SwapTypes.SwapExactIn;
} else if (args.type === 'SwapExactOut') {
    swapType = SwapTypes.SwapExactOut;
} else {
    throw Error('Invalid swap type: ' + args.type);
}
const swapAmount = BigNumber.from(args.quantity);

// GNO: 0x6810e776880c02933d47db1b9fc05908e5386b96
// WETH: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
// COW: 0xdef1ca1fb7fbcdc777520aa7f396b4e015f497ab
// DAI: 0x6b175474e89094c44da98b954eedeac495271d0f
// BAL: 0xba100000625a3754423978a60c9317c58a424e3d

// function convertGasCostToToken(
//     tokenAddress: string,
//     tokenDecimals: number,
//     gasPriceWei: BigNumber,
//     swapGas: BigNumber = BigNumber.from('35000')
// ): Promise<BigNumber> {
//     if (gasPriceWei.isZero() || swapGas.isZero()) return Zero;
//     const tokenPrice = await this.getNativeAssetPriceInToken(tokenAddress);
//     const tokenPriceWei = BigNumber.from(
//         scale(bnum(tokenPrice), tokenDecimals).dp(0).toString()
//     );

//     return gasPriceWei.mul(swapGas).mul(tokenPriceWei).div(ONE);
// }

const testPools = sanitizePoolData(pools);
// const testPools = pools;

// console.log(testPools);

/**
 * getCostOfSwapInToken Calculates and saves price of a swap in outputToken denomination. Used to determine if extra swaps are cost effective.
 * @param {string} outputToken - Address of outputToken.
 * @param {number} outputTokenDecimals - Decimals of outputToken.
 * @param {BigNumber} gasPrice - Gas price used to calculate cost.
 * @param {BigNumber} swapGas - Gas cost of a swap. Default=35000.
 * @returns {BigNumber} Price of a swap in outputToken denomination.
 */
function getCostOfSwapInToken(
    outputToken: string,
    outputTokenDecimals: number,
    gasPrice: BigNumber,
    swapGas?: BigNumber
): BigNumber {
    // if (gasPrice.isZero()) return Zero;
    // return this.swapCostCalculator.convertGasCostToToken(
    //     outputToken,
    //     outputTokenDecimals,
    //     gasPrice,
    //     swapGas
    // );
    return Zero;
}

function processSwaps(
    tokenIn: string,
    tokenOut: string,
    swapType: SwapTypes,
    swapAmount: BigNumber,
    pools: SubgraphPoolBase[],
    swapOptions: SwapOptions,
    routeProposer: RouteProposer
): SwapInfo {
    if (pools.length === 0) return cloneDeep(EMPTY_SWAPINFO);
    // console.log(pools.length);
    const paths = routeProposer.getCandidatePaths(
        tokenIn,
        tokenOut,
        swapType,
        pools,
        swapOptions
    );
    // console.log(paths);
    // fs.writeFile('./pools.json', JSON.stringify(pools), {}, (err) => {
    //     return undefined;
    // });

    if (paths.length == 0) return cloneDeep(EMPTY_SWAPINFO);

    // Path is guaranteed to contain both tokenIn and tokenOut
    let tokenInDecimals;
    let tokenOutDecimals;
    paths[0].swaps.forEach((swap) => {
        // Inject token decimals to avoid having to query onchain
        if (isSameAddress(swap.tokenIn, tokenIn)) {
            tokenInDecimals = swap.tokenInDecimals;
        }
        if (isSameAddress(swap.tokenOut, tokenOut)) {
            tokenOutDecimals = swap.tokenOutDecimals;
        }
    });

    const costOutputToken = getCostOfSwapInToken(
        swapType === SwapTypes.SwapExactIn ? tokenOut : tokenIn,
        swapType === SwapTypes.SwapExactIn ? tokenOutDecimals : tokenInDecimals,
        swapOptions.gasPrice,
        swapOptions.swapGas
    );

    // Returns list of swaps
    const [swaps, total, marketSp, totalConsideringFees] = getBestPaths2(
        paths,
        swapAmount,
        swapType,
        tokenInDecimals,
        tokenOutDecimals,
        costOutputToken,
        swapOptions.maxPools
    );

    const swapInfo = formatSwaps(
        swaps,
        swapType,
        swapAmount,
        tokenIn,
        tokenOut,
        total,
        totalConsideringFees,
        marketSp
    );

    return swapInfo;
}

/**
 * Find optimal routes for trade from given candidate paths
 */
function getBestPaths2(
    paths: NewPath[],
    swapAmount: BigNumber,
    swapType: SwapTypes,
    tokenInDecimals: number,
    tokenOutDecimals: number,
    costOutputToken: BigNumber,
    maxPools: number
): [Swap[][], BigNumber, string, BigNumber] {
    // swapExactIn - total = total amount swap will return of tokenOut
    // swapExactOut - total = total amount of tokenIn required for swap

    const [inputDecimals, outputDecimals] =
        swapType === SwapTypes.SwapExactIn
            ? [tokenInDecimals, tokenOutDecimals]
            : [tokenOutDecimals, tokenInDecimals];

    const [swaps, total, marketSp, totalConsideringFees] = getBestPaths(
        paths,
        swapType,
        swapAmount,
        inputDecimals,
        outputDecimals,
        maxPools,
        costOutputToken
    );

    return [
        swaps,
        parseFixed(
            total.dp(outputDecimals, OldBigNumber.ROUND_FLOOR).toString(),
            outputDecimals
        ),
        marketSp.toString(),
        parseFixed(
            totalConsideringFees
                .dp(outputDecimals, OldBigNumber.ROUND_FLOOR)
                .toString(),
            outputDecimals
        ),
    ];
}

const options: SwapOptions = {
    // gasPrice: BigNumber.from('40000000000'),
    gasPrice: Zero,
    maxPools: 4,
    // Default options
    swapGas: BigNumber.from('35000'),
    poolTypeFilter: PoolFilter.All,
    timestamp: Math.floor(Date.now() / 1000),
    forceRefresh: false,
};
// const swapAmount = parseFixed('3000', 18);

const config: SorConfig = {
    chainId: Network.MAINNET, //1
    vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    wETHwstETH: {
        id: '0x32296969ef14eb0c6d29669c550d4a0449130230000200000000000000000080',
        address: '0x32296969ef14eb0c6d29669c550d4a0449130230',
    },
};
const routeProposer = new RouteProposer(config);
const swapInfo = processSwaps(
    args.tokenIn,
    args.tokenOut,
    // ADDRESSES[Network.MAINNET].BAL.address,
    // ADDRESSES[Network.MAINNET].USDC.address,
    swapType,
    swapAmount,
    testPools,
    options,
    routeProposer
);

// const swapInfo = processSwaps(
//     'BAL',
//     'WETH',
//     SwapTypes.SwapExactIn,
//     swapAmount,
//     testPools,
//     options,
//     routeProposer
// );
console.log(JSON.stringify(swapInfo, null, 2));
