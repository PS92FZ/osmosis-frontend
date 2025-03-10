import { CoinPrimitive } from "@keplr-wallet/stores";
import { Dec, DecUtils } from "@keplr-wallet/unit";
import {
  ConcentratedLiquidityPoolRaw,
  CosmwasmPoolRaw,
  StablePoolRaw,
  WeightedPoolRaw,
} from "@osmosis-labs/pools";
import { CacheEntry, cachified } from "cachified";
import { LRUCache } from "lru-cache";

import { queryBalances } from "../cosmos";
import {
  FilteredPoolsResponse,
  PoolToken,
  queryFilteredPools,
} from "../indexer";
import { queryNumPools, queryPools } from "../osmosis";

export type PoolRaw =
  | CosmwasmPoolRaw
  | StablePoolRaw
  | ConcentratedLiquidityPoolRaw
  | WeightedPoolRaw;

export async function queryPaginatedPools({
  page,
  limit,
  minimumLiquidity,
  poolId: poolIdParam,
}: {
  page?: number;
  limit?: number;
  minimumLiquidity?: number;
  poolId?: string;
}): Promise<{
  status: number;
  pools: PoolRaw[];
  totalNumberOfPools: string;
  pageInfo?: {
    hasNextPage: boolean;
  };
}> {
  // Fetch the pools data from your database or other source
  // This is just a placeholder, replace it with your actual data fetching logic
  const { pools: allPools, totalNumberOfPools } = await fetchAndProcessAllPools(
    {
      minimumLiquidity,
    }
  );

  // Handle the case where specific pool ID is requested
  if (poolIdParam) {
    const pool = allPools.find(
      (pool) => ("pool_id" in pool ? pool.pool_id : pool.id) === poolIdParam
    );
    if (!pool) {
      throw { status: 404, pools: [] };
    }
    return { status: 200, pools: [pool], totalNumberOfPools };
  }

  // Pagination
  if (page && limit) {
    const startIndex = (page - 1) * limit;

    // Slice the data based on the page and limit
    const pools = allPools.slice(startIndex, startIndex + limit);

    // Return the paginated data
    return {
      status: 200,
      pools,
      totalNumberOfPools,
      pageInfo: {
        hasNextPage: startIndex + limit < allPools.length,
      },
    };
  }

  return { status: 200, pools: allPools, totalNumberOfPools };
}

/** Cache on this current edge function instance. */
const allPoolsLruCache = new LRUCache<string, CacheEntry>({
  max: 2,
});

async function fetchAndProcessAllPools({
  minimumLiquidity = 0,
}): Promise<{ pools: PoolRaw[]; totalNumberOfPools: string }> {
  return cachified({
    key: `all-pools-${minimumLiquidity}`,
    cache: allPoolsLruCache,
    async getFreshValue() {
      const numPools = await queryNumPools();

      // Fetch all pools from imperator, except cosmwasm pools for now
      // TODO remove when indexer returns cosmwasm pools
      try {
        const [filteredPoolsResponse, cosmwasmPools] = await Promise.all([
          queryFilteredPools(
            {
              min_liquidity: minimumLiquidity,
              order_by: "desc",
              order_key: "liquidity",
            },
            { offset: 0, limit: Number(numPools.num_pools) }
          ),
          getCosmwasmPools(),
        ]);
        const queryPoolRawResults = filteredPoolsResponse.pools.map(
          queryPoolRawFromFilteredPool
        );

        // prepend cosmwasm pools
        return {
          pools: (cosmwasmPools as PoolRaw[]).concat(
            queryPoolRawResults.filter(
              (
                poolRaw
              ): poolRaw is
                | StablePoolRaw
                | ConcentratedLiquidityPoolRaw
                | WeightedPoolRaw => !!poolRaw
            )
          ),
          totalNumberOfPools: numPools.num_pools,
        };
      } catch (e) {
        console.error(e);

        // fall back to pools query on node
        return {
          pools: await getPoolsFromNode(),
          totalNumberOfPools: numPools.num_pools,
        };
      }
    },
    ttl: 30 * 1000, // 30 seconds
  });
}

export function queryPoolRawFromFilteredPool(
  filteredPool: FilteredPoolsResponse["pools"][0]
): StablePoolRaw | ConcentratedLiquidityPoolRaw | WeightedPoolRaw | undefined {
  // deny pools containing tokens with gamm denoms
  if (
    Array.isArray(filteredPool.pool_tokens) &&
    filteredPool.pool_tokens.some(
      (token) => "denom" in token && token.denom.includes("gamm")
    )
  ) {
    return;
  }

  /** Metrics common to all pools. */
  const poolMetrics: {
    liquidityUsd: number;
    liquidity24hUsdChange: number;

    volume24hUsd: number;
    volume24hUsdChange: number;

    volume7dUsd: number;
  } = {
    liquidityUsd: filteredPool.liquidity,
    liquidity24hUsdChange: filteredPool.liquidity_24h_change,
    volume24hUsd: filteredPool.volume_24h,
    volume24hUsdChange: filteredPool.volume_24h_change,
    volume7dUsd: filteredPool.volume_7d,
  };

  if (
    filteredPool.type === "osmosis.concentratedliquidity.v1beta1.Pool" &&
    !Array.isArray(filteredPool.pool_tokens)
  ) {
    if (!filteredPool.pool_tokens.asset0 || !filteredPool.pool_tokens.asset1)
      return;

    const token0 = filteredPool.pool_tokens.asset0.denom;
    const token1 = filteredPool.pool_tokens.asset1.denom;

    return {
      "@type": `/${filteredPool.type}`,
      address: filteredPool.address,
      id: filteredPool.pool_id.toString(),
      current_tick_liquidity: filteredPool.current_tick_liquidity,
      token0,
      token0Amount: makeCoinFromToken(filteredPool.pool_tokens.asset0).amount,
      token1,
      token1Amount: makeCoinFromToken(filteredPool.pool_tokens.asset1).amount,
      current_sqrt_price: filteredPool.current_sqrt_price,
      current_tick: filteredPool.current_tick,
      tick_spacing: filteredPool.tick_spacing,
      exponent_at_price_one: filteredPool.exponent_at_price_one,
      spread_factor: filteredPool.spread_factor,
      ...poolMetrics,
    };
  }

  const sharePoolBase = {
    "@type": `/${filteredPool.type}`,
    id: filteredPool.pool_id.toString(),
    pool_params: {
      exit_fee: new Dec(filteredPool.exit_fees.toString())
        .mul(DecUtils.getTenExponentN(-2))
        .toString(),
      swap_fee: new Dec(filteredPool.swap_fees.toString())
        .mul(DecUtils.getTenExponentN(-2))
        .toString(),
      smooth_weight_change_params: null,
    },
    total_shares: filteredPool.total_shares,
    ...poolMetrics,
  };

  if (
    filteredPool.type === "osmosis.gamm.v1beta1.Pool" &&
    Array.isArray(filteredPool.pool_tokens)
  ) {
    return {
      ...sharePoolBase,
      pool_assets: filteredPool.pool_tokens.map((token) => ({
        token: {
          denom: token.denom,
          amount: floatNumberToStringInt(token.amount, token.exponent),
        },
        weight: token.weight_or_scaling.toString(),
      })),
      total_weight: filteredPool.total_weight_or_scaling.toString(),
    };
  }

  if (
    filteredPool.type === "osmosis.gamm.poolmodels.stableswap.v1beta1.Pool" &&
    Array.isArray(filteredPool.pool_tokens)
  ) {
    return {
      ...sharePoolBase,
      pool_liquidity: filteredPool.pool_tokens.map((token) => ({
        denom: token.denom,
        amount: floatNumberToStringInt(token.amount, token.exponent),
      })),
      scaling_factors: filteredPool.pool_tokens.map((token) =>
        token.weight_or_scaling.toString()
      ),
      scaling_factor_controller: filteredPool.scaling_factor_controller ?? "",
    };
  }

  throw new Error("Filtered pool not properly serialized as a valid pool.");
}

/** Converts a number with exponent decimals into a whole integer. */
function floatNumberToStringInt(number: number, exponent: number): string {
  return new Dec(number.toString())
    .mul(DecUtils.getTenExponentN(exponent))
    .truncate()
    .toString();
}

function makeCoinFromToken(poolToken: PoolToken): CoinPrimitive {
  return {
    denom: poolToken.denom,
    amount: floatNumberToStringInt(poolToken.amount, poolToken.exponent),
  };
}

const cosmwasmPoolsCache = new LRUCache<string, CacheEntry>({
  max: 10,
});
async function getCosmwasmPools(): Promise<CosmwasmPoolRaw[]> {
  return cachified({
    key: "cosmwasm-pools",
    cache: cosmwasmPoolsCache,
    async getFreshValue() {
      const { pools } = await queryPools();
      const cosmwasmPools = pools.filter(
        (pool) => pool["@type"] === "/osmosis.cosmwasmpool.v1beta1.CosmWasmPool"
      ) as CosmwasmPoolRaw[];

      const poolBalancesPromises = cosmwasmPools.map(
        async (pool) => await queryBalances(pool.contract_address)
      );
      const poolBalances = await Promise.all(poolBalancesPromises);

      return cosmwasmPools
        .map((pool, index) => {
          if (poolBalances[index].balances.length < 2) return;

          return {
            ...pool,
            tokens: poolBalances[index].balances.map((balance) => ({
              denom: balance.denom,
              amount: balance.amount,
            })),
          };
        })
        .filter((pool): pool is CosmwasmPoolRaw => !!pool) as CosmwasmPoolRaw[];
    },
    ttl: 30 * 1000, // 30 seconds, since this data doesn't change often
  });
}

/** Gets pools from nodes, and queries for balances if needed. */
async function getPoolsFromNode(): Promise<PoolRaw[]> {
  const nodePools = await queryPools();

  // convert node pool responses to pool raws
  const poolPromises = nodePools.pools.map(async (responsePool) => {
    if (responsePool["@type"] === "/osmosis.gamm.v1beta1.Pool") {
      return responsePool as WeightedPoolRaw;
    }
    if (
      responsePool["@type"] ===
      "/osmosis.gamm.poolmodels.stableswap.v1beta1.Pool"
    ) {
      return responsePool as StablePoolRaw;
    }
    if (
      responsePool["@type"] === "/osmosis.concentratedliquidity.v1beta1.Pool"
    ) {
      const { balances: clBalances } = await queryBalances(
        responsePool.address
      );

      const token0Amount = clBalances.find((balance) => {
        return balance.denom === responsePool.token0;
      });
      const token1Amount = clBalances.find((balance) => {
        return balance.denom === responsePool.token1;
      });

      if (!token0Amount || !token1Amount) return;

      return {
        ...responsePool,
        token0Amount: token0Amount.amount,
        token1Amount: token1Amount.amount,
      } as ConcentratedLiquidityPoolRaw;
    }
    if (
      responsePool["@type"] === "/osmosis.cosmwasmpool.v1beta1.CosmWasmPool"
    ) {
      const { balances } = await queryBalances(responsePool.contract_address);

      return {
        ...responsePool,
        tokens: balances,
      } as CosmwasmPoolRaw;
    }
  });

  const pools = await Promise.all(poolPromises);

  return pools.filter((pool): pool is PoolRaw => !!pool);
}
