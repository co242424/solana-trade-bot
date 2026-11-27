import { Connection, PublicKey } from "@solana/web3.js";
import { WSOL_MINT } from "./config.js";

export function makeConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, "confirmed");
}

export async function getMintDecimals(
  connection: Connection,
  mint: string,
): Promise<number> {
  if (mint === WSOL_MINT) return 9;
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const data = info.value?.data;
  if (!data || Buffer.isBuffer(data) || !("parsed" in data)) {
    throw new Error(`Mint ${mint} not found or not an SPL mint`);
  }
  const decimals = (data.parsed as { info?: { decimals?: number } }).info?.decimals;
  if (typeof decimals !== "number") {
    throw new Error(`Mint ${mint} has no decimals field`);
  }
  return decimals;
}

/** Sum of the owner's balances for a mint across token accounts (SPL Token and Token-2022). */
export async function getTokenBalanceRaw(
  connection: Connection,
  owner: PublicKey,
  mint: string,
): Promise<{ raw: bigint; accounts: number }> {
  const res = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(mint),
  });
  let raw = 0n;
  for (const acc of res.value) {
    const amount = (acc.account.data.parsed as { info: { tokenAmount: { amount: string } } })
      .info.tokenAmount.amount;
    raw += BigInt(amount);
  }
  return { raw, accounts: res.value.length };
}
