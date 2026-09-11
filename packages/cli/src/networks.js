/**
 * Well-known public Horizon endpoints. Kept intentionally small: only
 * long-standing, documented SDF-operated URLs, so a default network name
 * never silently points somewhere unexpected.
 *
 * There is deliberately no default public RPC URL here. Unlike Horizon's
 * endpoints, public stellar-rpc URLs and their availability/rate-limit
 * policies change more often, and guessing one wrong would send a user's
 * lookup somewhere they didn't ask for. `--rpc-url` is required whenever
 * `--source rpc` is selected.
 */
const HORIZON_NETWORKS = Object.freeze({
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
});

export const DEFAULT_NETWORK = "testnet";

/**
 * Resolves `--network` / `--horizon-url` / `--rpc-url` into a concrete
 * endpoint configuration.
 *
 * @param {object} args
 * @param {string} [args.network] One of "testnet" | "mainnet" | "futurenet".
 * @param {string} [args.horizonUrl] Explicit Horizon base URL; overrides `network`.
 * @param {string} [args.rpcUrl] Explicit RPC base URL.
 * @returns {{ horizonUrl: string, rpcUrl: string|undefined, network: string }}
 */
export function resolveNetwork({ network, horizonUrl, rpcUrl } = {}) {
  const resolvedNetworkName = network ?? DEFAULT_NETWORK;

  if (network !== undefined && !horizonUrl && !(network in HORIZON_NETWORKS)) {
    throw new Error(
      `Unknown network "${network}". Expected one of: ${Object.keys(HORIZON_NETWORKS).join(", ")}, or pass --horizon-url / --rpc-url explicitly.`,
    );
  }

  return {
    network: resolvedNetworkName,
    horizonUrl: horizonUrl ?? HORIZON_NETWORKS[resolvedNetworkName],
    rpcUrl,
  };
}
