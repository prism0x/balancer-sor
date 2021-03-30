import fetch from 'isomorphic-fetch';
import { SubGraphPools } from './types';
import {
    DisabledOptions,
    SubgraphPoolBase,
    PoolDictionary,
    TypesForSwap,
    Path,
    Swap,
    PoolBase,
} from './types';
import { WeightedPool } from './pools/weightedPool';
import { StablePool } from './pools/StablePool';
import { bnum } from './bmath';

import disabledTokensDefault from './disabled-tokens.json';

export class POOLS {
    async getAllPublicSwapPools(URL: string): Promise<SubGraphPools> {
        const result = await fetch(URL);
        const allPools = result.json();
        return allPools;
    }
}

/*
The main purpose of this function is to:
- filter to  allPools to pools that have:
    - TokenIn & TokenOut, i.e. a direct swap pool
    - TokenIn & !TokenOut, i.e. a hop pool with only TokenIn
    - !TokenIn & TokenOut, i.e. a hop pool with only TokenOut
- find list of hop tokens, i.e. tokens that join hop pools
As we're looping all here, it also does a number of other things to avoid unnecessary loops later:
- parsePoolPairData for Direct pools
- store token decimals for future use
*/
export function filterPoolsOfInterest(
    allPools: SubgraphPoolBase[],
    tokenIn: string,
    tokenOut: string,
    maxPools: number,
    disabledOptions: DisabledOptions = { isOverRide: false, disabledTokens: [] }
): [PoolDictionary, string[]] {
    const poolsDictionary: PoolDictionary = {};

    // If pool contains token add all its tokens to direct list
    // Multi-hop trades: we find the best pools that connect tokenIn and tokenOut through a multi-hop (intermediate) token
    // First: we get all tokens that can be used to be traded with tokenIn excluding
    // tokens that are in pools that already contain tokenOut (in which case multi-hop is not necessary)
    let tokenInPairedTokens: Set<string> = new Set();
    let tokenOutPairedTokens: Set<string> = new Set();

    let disabledTokens = disabledTokensDefault.tokens;
    if (disabledOptions.isOverRide)
        disabledTokens = disabledOptions.disabledTokens;

    allPools.forEach(pool => {
        let newPool: WeightedPool | StablePool;

        // TODO - Update for new Schema
        if (typeof pool.amp === 'undefined' || pool.amp === '0')
            newPool = new WeightedPool(
                pool.id,
                pool.swapFee,
                pool.totalWeight,
                pool.totalShares,
                pool.tokens,
                pool.tokensList
            );
        else
            newPool = new StablePool(
                pool.id,
                pool.amp,
                pool.swapFee,
                pool.totalShares,
                pool.tokens,
                pool.tokensList
            );

        let tokenListSet = new Set(pool.tokensList);
        // we add the BPT as well as we can join/exit as part of the multihop
        tokenListSet.add(pool.id);
        disabledTokens.forEach(token => tokenListSet.delete(token.address));

        // This is a direct pool as has both tokenIn and tokenOut
        if (
            (tokenListSet.has(tokenIn) && tokenListSet.has(tokenOut)) ||
            (tokenListSet.has(tokenIn.toLowerCase()) &&
                tokenListSet.has(tokenOut.toLowerCase()))
        ) {
            newPool.setTypeForSwap(TypesForSwap.Direct);
            // parsePoolPairData for Direct pools as it avoids having to loop later
            newPool.parsePoolPairData(tokenIn, tokenOut);
            poolsDictionary[pool.id] = newPool;
            return;
        }

        if (maxPools > 1) {
            let containsTokenIn = tokenListSet.has(tokenIn);
            let containsTokenOut = tokenListSet.has(tokenOut);

            if (containsTokenIn && !containsTokenOut) {
                tokenInPairedTokens = new Set([
                    ...tokenInPairedTokens,
                    ...tokenListSet,
                ]);
                newPool.setTypeForSwap(TypesForSwap.HopIn);
                poolsDictionary[pool.id] = newPool;
            } else if (!containsTokenIn && containsTokenOut) {
                tokenOutPairedTokens = new Set([
                    ...tokenOutPairedTokens,
                    ...tokenListSet,
                ]);
                newPool.setTypeForSwap(TypesForSwap.HopOut);
                poolsDictionary[pool.id] = newPool;
            }
        }
    });

    // We find the intersection of the two previous sets so we can trade tokenIn for tokenOut with 1 multi-hop
    const hopTokensSet = [...tokenInPairedTokens].filter(x =>
        tokenOutPairedTokens.has(x)
    );

    // Transform set into Array
    const hopTokens = [...hopTokensSet];
    return [poolsDictionary, hopTokens];
}
/*
Find the most liquid pool for each hop (i.e. tokenIn->hopToken & hopToken->tokenOut).
Creates paths for each pool of interest (multi & direct pools).
*/
export function filterHopPools(
    tokenIn: string,
    tokenOut: string,
    hopTokens: string[],
    poolsOfInterest: PoolDictionary
): [PoolDictionary, Path[]] {
    const filteredPoolsOfInterest: PoolDictionary = {};
    const paths: Path[] = [];
    let firstPoolLoop = true;

    // No multihop pool but still need to create paths for direct pools
    if (hopTokens.length === 0) {
        for (let id in poolsOfInterest) {
            const path = createDirectPath(
                poolsOfInterest[id],
                tokenIn,
                tokenOut
            );
            paths.push(path);
            filteredPoolsOfInterest[id] = poolsOfInterest[id];
        }
    }

    for (let i = 0; i < hopTokens.length; i++) {
        let highestNormalizedLiquidityFirst = bnum(0); // Aux variable to find pool with most liquidity for pair (tokenIn -> hopToken)
        let highestNormalizedLiquidityFirstPoolId: string; // Aux variable to find pool with most liquidity for pair (tokenIn -> hopToken)
        let highestNormalizedLiquiditySecond = bnum(0); // Aux variable to find pool with most liquidity for pair (hopToken -> tokenOut)
        let highestNormalizedLiquiditySecondPoolId: string; // Aux variable to find pool with most liquidity for pair (hopToken -> tokenOut)

        for (let id in poolsOfInterest) {
            const pool = poolsOfInterest[id];

            // We don't consider direct pools for the multihop but we do add it's path
            if (pool.typeForSwap === TypesForSwap.Direct) {
                // First loop of all pools we add paths to list
                if (firstPoolLoop) {
                    const path = createDirectPath(pool, tokenIn, tokenOut);
                    paths.push(path);
                    filteredPoolsOfInterest[id] = pool;
                }
                continue;
            }

            // If pool doesn't have  hopTokens[i] then ignore
            if (!new Set(pool.tokensList).add(pool.id).has(hopTokens[i]))
                continue;

            if (pool.typeForSwap === TypesForSwap.HopIn) {
                pool.parsePoolPairData(tokenIn, hopTokens[i]);
                // const normalizedLiquidity = pool.getNormalizedLiquidity(tokenIn, hopTokens[i]);
                const normalizedLiquidity = pool.getNormalizedLiquidity();
                // Cannot be strictly greater otherwise highestNormalizedLiquidityPoolId = 0 if hopTokens[i] balance is 0 in this pool.
                if (
                    normalizedLiquidity.isGreaterThanOrEqualTo(
                        highestNormalizedLiquidityFirst
                    )
                ) {
                    highestNormalizedLiquidityFirst = normalizedLiquidity;
                    highestNormalizedLiquidityFirstPoolId = id;
                }
            } else if (pool.typeForSwap === TypesForSwap.HopOut) {
                pool.parsePoolPairData(hopTokens[i], tokenOut);
                // const normalizedLiquidity = pool.getNormalizedLiquidity(hopTokens[i], tokenOut);
                const normalizedLiquidity = pool.getNormalizedLiquidity();
                // Cannot be strictly greater otherwise highestNormalizedLiquidityPoolId = 0 if hopTokens[i] balance is 0 in this pool.
                if (
                    normalizedLiquidity.isGreaterThanOrEqualTo(
                        highestNormalizedLiquiditySecond
                    )
                ) {
                    highestNormalizedLiquiditySecond = normalizedLiquidity;
                    highestNormalizedLiquiditySecondPoolId = id;
                }
            } else {
                // Unknown type
                continue;
            }
        }

        firstPoolLoop = false;

        filteredPoolsOfInterest[highestNormalizedLiquidityFirstPoolId] =
            poolsOfInterest[highestNormalizedLiquidityFirstPoolId];
        filteredPoolsOfInterest[highestNormalizedLiquiditySecondPoolId] =
            poolsOfInterest[highestNormalizedLiquiditySecondPoolId];

        const path = createMultihopPath(
            poolsOfInterest[highestNormalizedLiquidityFirstPoolId],
            poolsOfInterest[highestNormalizedLiquiditySecondPoolId],
            tokenIn,
            hopTokens[i],
            tokenOut
        );

        paths.push(path);
    }

    return [filteredPoolsOfInterest, paths];
}

function createDirectPath(
    pool: PoolBase,
    tokenIn: string,
    tokenOut: string
): Path {
    const swap: Swap = {
        pool: pool.id,
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        tokenInDecimals: 18, // TO DO - Add decimals here
        tokenOutDecimals: 18,
    };

    const path: Path = {
        id: pool.id,
        swaps: [swap],
    };

    return path;
}

function createMultihopPath(
    firstPool: PoolBase,
    secondPool: PoolBase,
    tokenIn: string,
    hopToken: string,
    tokenOut: string
): Path {
    const swap1: Swap = {
        pool: firstPool.id,
        tokenIn: tokenIn,
        tokenOut: hopToken,
        tokenInDecimals: 18, // Placeholder for actual decimals TO DO
        tokenOutDecimals: 18,
    };

    const swap2: Swap = {
        pool: secondPool.id,
        tokenIn: hopToken,
        tokenOut: tokenOut,
        tokenInDecimals: 18, // Placeholder for actual decimals TO DO
        tokenOutDecimals: 18,
    };

    // Path id is the concatenation of the ids of poolFirstHop and poolSecondHop
    const path: Path = {
        id: firstPool.id + secondPool.id,
        swaps: [swap1, swap2],
    };

    return path;
}
