import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  closeAccount,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { BN } from "bn.js";
import type { ContinuousToken } from "../target/types/continuous_token";

export interface User {
  keypair: anchor.web3.Keypair;
  publicKey: anchor.web3.PublicKey;
  RtAta: anchor.web3.PublicKey;
  CtAta: anchor.web3.PublicKey;
}

export interface ProgramAddresses {
  configPda: anchor.web3.PublicKey;
  configBump: number;
  ctMintPda: anchor.web3.PublicKey;
  feeVaultLockedPda: anchor.web3.PublicKey;
  vaultRt: anchor.web3.PublicKey;
  vaultCtUnlocked: anchor.web3.PublicKey;
  vaultCtLocked: anchor.web3.PublicKey;
}

export type InitializeConfig = {
  seed: anchor.BN;
  curve: BondingCurveParams;
  meta: TokenMetadata;
};

export type BondingCurveParams = {
  firstPrice: anchor.BN;
  reserveRatioBps: number;
  baseFeeBps: number;
  discountBps: number;
};

export type TokenMetadata = {
  name: string;
  symbol: string;
  uri: string;
};

type SetupUserOpts = {
  rtAmount?: number; // TODO: CHANGE TO BIGINT
  sol?: number;
};

type BuySimulationResult = {
  totalCt: bigint;
  lockedVaultCt: bigint;
  userCt: bigint;
  referrerCt: bigint;
  finalFeeBps: number;
};

type SellSimulationResult = {
  feeCt: bigint;
  burnedCt: bigint;
  userRt: bigint;
  netCt: bigint;
};

type PdaWithBump = [anchor.web3.PublicKey, number];

type TokenAuto =
  | {
      kind: "token";
      address: anchor.web3.PublicKey;
      amount: bigint;
      mint: anchor.web3.PublicKey;
      owner: anchor.web3.PublicKey;
      programId: anchor.web3.PublicKey;
    }
  | {
      kind: "mint";
      address: anchor.web3.PublicKey;
      supply: bigint;
      decimals: number;
      programId: anchor.web3.PublicKey;
    }
  | { kind: "missing"; address: anchor.web3.PublicKey };

type AccountSnapshot = Record<string, TokenAuto>;

function h_getAuto<T extends TokenAuto["kind"]>(
  snapshot: AccountSnapshot,
  pubkey: anchor.web3.PublicKey,
  kind: T,
  opts: { strict?: boolean } = { strict: true },
): Extract<TokenAuto, { kind: T }> | null {
  const { strict = true } = opts;
  const pk = pubkey.toBase58();
  const v = snapshot[pk];

  if (!v) {
    if (strict) throw new Error(`Missing account: ${pk}`);
    return null;
  }

  if (v.kind !== kind) {
    if (strict) {
      throw new Error(`Expected ${kind}: ${pk}, got ${v.kind}`);
    }
    return null;
  }

  return v as Extract<TokenAuto, { kind: T }>;
}

export type BuyerSpec = {
  solToDeposit?: bigint;
  rtToDeposit?: bigint;
  rtToBuy: bigint;
};

export const RT_DECIMALS = 6;
const DEFAULT_RT_AMOUNT = 1 * 10 ** RT_DECIMALS;
const DEFAULT_SOL_AMOUNT = 10;

export const DEFAULT_INIT_CONFIG: InitializeConfig = {
  seed: new BN(1),
  curve: {
    firstPrice: new BN(0.01 * 10 ** RT_DECIMALS),
    reserveRatioBps: 9_000, // 90%
    baseFeeBps: 100, // 1%
    discountBps: 50, // 0.5%
  },
  meta: {
    name: "RT Token",
    symbol: "RT",
    uri: "https://example.com/rt-token-metadata.json",
  },
};

export function randomBN(max: number, rng = Math.random) {
  return new BN(Math.floor(rng() * max));
}

export function BNtoBigInt(n: anchor.BN): bigint {
  return BigInt(n.toString());
}

export async function airdrop(
  provider: anchor.AnchorProvider,
  publicKey: anchor.web3.PublicKey,
  sol = 10,
): Promise<void> {
  const signature = await provider.connection.requestAirdrop(
    publicKey,
    sol * anchor.web3.LAMPORTS_PER_SOL,
  );
  const latestBlockHash = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction(
    { signature, ...latestBlockHash },
    "confirmed",
  );
}

export async function airdropRT(
  provider: anchor.AnchorProvider,
  mintRT: anchor.web3.PublicKey,
  destination: anchor.web3.PublicKey,
  amount: bigint = BigInt(1000000),
): Promise<void> {
  const ata = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    provider.wallet.payer,
    mintRT,
    destination,
  );

  await mintTo(
    provider.connection,
    provider.wallet.payer,
    mintRT,
    ata.address,
    provider.wallet.publicKey,
    amount,
  );
}

export async function getMintAuto_single(
  connection: anchor.web3.Connection,
  mint: anchor.web3.PublicKey,
) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error("Mint not found");

  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  return getMint(connection, mint, undefined, programId);
}

export async function getAccountAuto_single(
  connection: anchor.web3.Connection,
  account: anchor.web3.PublicKey,
) {
  const info = await connection.getAccountInfo(account);
  if (!info) throw new Error("Account not found");

  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  return getAccount(connection, account, undefined, programId);
}

export async function setupUser(
  provider: anchor.AnchorProvider,
  mintRt: anchor.web3.PublicKey,
  ctMintPda: anchor.web3.PublicKey,
  opts: SetupUserOpts = {
    rtAmount: DEFAULT_RT_AMOUNT,
    sol: DEFAULT_SOL_AMOUNT,
  },
  // TODO: Change to bigint
): Promise<User> {
  const keypair = anchor.web3.Keypair.generate();

  await airdrop(provider, keypair.publicKey, opts.sol);

  const ataRt = getAssociatedTokenAddressSync(
    mintRt,
    keypair.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    anchor.utils.token.ASSOCIATED_PROGRAM_ID,
  );

  if (opts.rtAmount > 0) {
    await airdropRT(provider, mintRt, keypair.publicKey, BigInt(opts.rtAmount));
  }

  const ataCt = getAssociatedTokenAddressSync(
    ctMintPda,
    keypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    anchor.utils.token.ASSOCIATED_PROGRAM_ID,
  );

  return {
    keypair,
    publicKey: keypair.publicKey,
    RtAta: ataRt,
    CtAta: ataCt,
  };
}

export async function drainSol(
  provider: anchor.AnchorProvider,
  from: anchor.web3.Keypair,
  to: anchor.web3.PublicKey = provider.wallet.publicKey,
  leaveLamports = 5_000,
) {
  const balance = await provider.connection.getBalance(from.publicKey);

  const lamportsToSend = Math.max(0, balance - leaveLamports);

  if (lamportsToSend === 0) return;

  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: lamportsToSend,
    }),
  );

  await provider.sendAndConfirm(tx, [from]);
}

export async function drainATAs(
  provider: anchor.AnchorProvider,
  from: anchor.web3.Keypair,
  to: anchor.web3.PublicKey = provider.wallet.publicKey,
  mints: anchor.web3.PublicKey[] = [],
  leaveAmount = 0n,
  close = false,
) {
  const connection = provider.connection;

  const [spl, t22] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(from.publicKey, {
      programId: TOKEN_PROGRAM_ID,
    }),
    connection.getParsedTokenAccountsByOwner(from.publicKey, {
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  ]);

  const mintFilter =
    mints.length > 0 ? new Set(mints.map((m) => m.toBase58())) : null;

  const txs: anchor.web3.Transaction[] = [];
  let tx = new anchor.web3.Transaction();

  const all = [...spl.value, ...t22.value];
  if (all.length === 0) return;

  for (const { pubkey, account } of all) {
    const parsed = account.data.parsed.info;
    const mint = new anchor.web3.PublicKey(parsed.mint);
    const rawAmount = BigInt(parsed.tokenAmount.amount);
    const tokenProgramId = account.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

    if (mintFilter && !mintFilter.has(mint.toBase58())) continue;
    if (rawAmount <= leaveAmount) continue;

    const destAta = getAssociatedTokenAddressSync(
      mint,
      to,
      false,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const destInfo = await connection.getAccountInfo(destAta);
    if (!destInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          provider.wallet.publicKey,
          destAta,
          to,
          mint,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }

    const toSend = rawAmount - leaveAmount;

    tx.add(
      createTransferInstruction(
        pubkey,
        destAta,
        from.publicKey,
        toSend,
        [],
        tokenProgramId,
      ),
    );

    console.log("DRAIN: ", { close, leaveAmount, rawAmount, toSend });
    if (close && leaveAmount === 0n) {
      tx.add(
        createCloseAccountInstruction(
          pubkey,
          from.publicKey,
          from.publicKey,
          [],
          tokenProgramId,
        ),
      );
    }

    if (tx.instructions.length >= 6) {
      txs.push(tx);
      tx = new anchor.web3.Transaction();
    }
  }

  if (tx.instructions.length > 0) txs.push(tx);

  for (const t of txs) {
    await provider.sendAndConfirm(t, [from]);
  }
}

export async function deriveProgramAddresses(
  seed: anchor.BN,
  mintRt: anchor.web3.PublicKey,
  programId: anchor.web3.PublicKey,
): Promise<Readonly<ProgramAddresses>> {
  const [configPda, configBump] = getConfigPdaAddress(seed, programId);
  const [ctMintPda] = getCtMintPdaAddress(seed, programId);
  const [feeVaultLockedPda] = getFeeVaultLockedPdaAddress(seed, programId);

  const vaultRt = ata(mintRt, configPda);
  const vaultCtUnlocked = ata(ctMintPda, configPda, TOKEN_2022_PROGRAM_ID);
  const vaultCtLocked = ata(
    ctMintPda,
    feeVaultLockedPda,
    TOKEN_2022_PROGRAM_ID,
  );

  return Object.freeze({
    configPda,
    configBump,
    ctMintPda,
    feeVaultLockedPda,
    vaultRt,
    vaultCtUnlocked,
    vaultCtLocked,
  });
}

export async function initializeProgram(
  program: anchor.Program<ContinuousToken>,
  provider: anchor.AnchorProvider,
  addrs: ProgramAddresses,
  mintRt: anchor.web3.PublicKey,
  cfg: InitializeConfig,
): Promise<void> {
  const { seed, curve, meta } = cfg;

  await program.methods
    .initialize(
      seed,
      curve.firstPrice,
      curve.reserveRatioBps,
      curve.baseFeeBps,
      curve.discountBps,
      meta.name,
      meta.symbol,
      meta.uri,
    )
    .accountsStrict({
      initializer: provider.wallet.publicKey,
      config: addrs.configPda,
      mintRt,
      mintCt: addrs.ctMintPda,
      vaultRt: addrs.vaultRt,
      vaultCtLocked: addrs.vaultCtLocked,
      vaultCtUnlocked: addrs.vaultCtUnlocked,
      feeVaultAuthority: addrs.feeVaultLockedPda,
      tokenProgramRt: anchor.utils.token.TOKEN_PROGRAM_ID,
      tokenProgramCt: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
}

export function buyAccounts(
  addrs: ProgramAddresses,
  mintRt: anchor.web3.PublicKey,
  buyer: User,
  referrer?: User,
) {
  return {
    config: addrs.configPda,
    buyer: buyer.publicKey,
    mintRt: mintRt,
    mintCt: addrs.ctMintPda,
    vaultRt: addrs.vaultRt,
    vaultCtUnlocked: addrs.vaultCtUnlocked,
    vaultCtLocked: addrs.vaultCtLocked,
    feeVaultAuthority: addrs.feeVaultLockedPda,
    buyerRtAta: buyer.RtAta,
    buyerCtAta: buyer.CtAta,
    referrer: referrer?.publicKey ?? null,
    referrerCtAta: referrer?.CtAta ?? null,
    tokenProgramRt: anchor.utils.token.TOKEN_PROGRAM_ID,
    tokenProgramCt: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    systemProgram: anchor.web3.SystemProgram.programId,
  };
}

export function sellAccounts(
  addrs: ProgramAddresses,
  mintRt: anchor.web3.PublicKey,
  seller: User,
) {
  return {
    config: addrs.configPda,
    seller: seller.publicKey,
    mintRt: mintRt,
    mintCt: addrs.ctMintPda,
    vaultRt: addrs.vaultRt,
    vaultCtUnlocked: addrs.vaultCtUnlocked,
    vaultCtLocked: addrs.vaultCtLocked,
    feeVaultAuthority: addrs.feeVaultLockedPda,
    sellerRtAta: seller.RtAta,
    sellerCtAta: seller.CtAta,
    tokenProgramRt: anchor.utils.token.TOKEN_PROGRAM_ID,
    tokenProgramCt: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    systemProgram: anchor.web3.SystemProgram.programId,
  };
}

export async function getAtaTokenBalance(
  connection: anchor.web3.Connection,
  ata: anchor.web3.PublicKey,
): Promise<bigint> {
  try {
    const account = await connection.getTokenAccountBalance(ata);
    return BigInt(account.value.amount);
  } catch {
    return 0n;
  }
}

export function bondingCurveBuy(
  decimals: number,
  firstPrice: number,
  reserveRatioBps: number,
  supply: number,
  reserve: number,
  amount: number,
): number {
  if (amount < 0) throw new Error("amount must be >= 0");

  const alpha = reserveRatioBps / 10_000;
  const scale = 10 ** decimals;

  const k =
    supply === 0 ? firstPrice : reserve / (supply / scale) ** (1 / alpha);

  const rNew = reserve + amount;
  const newSupply = (rNew / k) ** alpha;
  const newSupplyU = Math.floor(newSupply * scale);
  const deltaS = Math.max(0, newSupplyU - supply);

  return Math.max(0, deltaS);
}

export function simulateBuy(params: {
  decimals: number;
  amount: bigint;
  reserve: bigint;
  supply: bigint;
  hasReferrer: boolean;
  firstPrice: bigint;
  reserveRatioBps: number;
  baseFeeBps: number;
  discountBps: number;
}): BuySimulationResult {
  const {
    decimals,
    amount,
    reserve,
    supply,
    hasReferrer,
    firstPrice,
    reserveRatioBps,
    baseFeeBps,
    discountBps,
  } = params;

  const totalCtNum = bondingCurveBuy(
    decimals,
    Number(firstPrice),
    reserveRatioBps,
    Number(supply),
    Number(reserve),
    Number(amount),
  );

  const totalCt = BigInt(totalCtNum);

  const finalFeeBps = hasReferrer ? baseFeeBps - discountBps : baseFeeBps;

  if (finalFeeBps < 0) {
    throw new Error("finalFeeBps underflow");
  }

  const fee = (totalCt * BigInt(finalFeeBps)) / 10_000n;

  const userCt = totalCt - fee;
  const [referrerCt, lockedVaultCt] = hasReferrer ? [fee, 0n] : [0n, fee];

  return {
    totalCt,
    lockedVaultCt,
    userCt,
    referrerCt,
    finalFeeBps,
  };
}

export async function h_getTokenAccountsAuto(
  connection: anchor.web3.Connection,
  addrs: anchor.web3.PublicKey[],
  opts: { strict?: boolean } = { strict: true },
): Promise<AccountSnapshot> {
  const infos = await connection.getMultipleAccountsInfo(addrs);

  const out: AccountSnapshot = {};

  infos.forEach((info, i) => {
    if (!info) {
      if (opts.strict) {
        throw new Error(`Account not found: ${addrs[i].toBase58()}`);
      } else {
        out[addrs[i].toBase58()] = {
          kind: "missing",
          address: addrs[i],
        };
        return;
      }
    }

    const programId = info.owner;

    if (
      !programId.equals(TOKEN_PROGRAM_ID) &&
      !programId.equals(TOKEN_2022_PROGRAM_ID)
    ) {
      throw new Error(
        `Unsupported owner ${programId.toBase58()} for ${addrs[i].toBase58()}`,
      );
    }

    try {
      // unpackAccount / unpackMint support Token-2022 extensions
      const tokenAcct = unpackAccount(addrs[i], info, programId);
      out[addrs[i].toBase58()] = {
        kind: "token",
        address: addrs[i],
        amount: tokenAcct.amount,
        mint: tokenAcct.mint,
        owner: tokenAcct.owner,
        programId,
      };
      return;
    } catch (_) {
      // not a token account, try mint
    }

    try {
      const mint = unpackMint(addrs[i], info, programId);
      out[addrs[i].toBase58()] = {
        kind: "mint",
        address: addrs[i],
        supply: mint.supply,
        decimals: mint.decimals,
        programId,
      };
      return;
    } catch (_) {
      // not a mint
    }

    throw new Error(
      `Account ${addrs[i].toBase58()} is not a token account or mint`,
    );
  });

  return out;
}

export function h_getMintAuto(
  snapshot: AccountSnapshot,
  pubkey: anchor.web3.PublicKey,
  opts?: { strict?: boolean },
) {
  const v = h_getAuto(snapshot, pubkey, "mint", opts);
  if (!v) throw new Error("Expected mint");
  return v;
}

export function h_getTokenAuto(
  snapshot: AccountSnapshot,
  pubkey: anchor.web3.PublicKey,
  opts?: { strict?: boolean },
) {
  const v = h_getAuto(snapshot, pubkey, "token", opts);
  if (!v) throw new Error("Expected token account");
  return v;
}

export function h_getTokenAmount(
  snapshot: AccountSnapshot,
  pubkey: anchor.web3.PublicKey,
  opts?: { strict?: boolean },
): bigint {
  const v = h_getAuto(snapshot, pubkey, "token", opts);
  return v ? v.amount : 0n;
}

export function h_getMintSupply(
  snapshot: AccountSnapshot,
  pubkey: anchor.web3.PublicKey,
  opts?: { strict?: boolean },
): bigint {
  const v = h_getAuto(snapshot, pubkey, "mint", opts);
  return v ? v.supply : 0n;
}

export function h_getAmountBeforeAfter(
  snapshotBefore: AccountSnapshot,
  snapshotAfter: AccountSnapshot,
  pubkey: anchor.web3.PublicKey,
  opts: { strict?: boolean } = { strict: true },
): [bigint, bigint] {
  const pk = pubkey.toBase58();

  const read = (s: AccountSnapshot): bigint => {
    const v = s[pk];

    if (!v) {
      if (opts.strict) throw new Error(`Missing account: ${pk}`);
      return 0n;
    }

    if (v.kind === "token") return v.amount;
    if (v.kind === "mint") return v.supply;

    if (opts.strict) throw new Error(`Unknown token kind for ${pk}`);
    return 0n;
  };

  return [read(snapshotBefore), read(snapshotAfter)];
}

export function snapshotAmountBeforeAfter(
  before: AccountSnapshot,
  after: AccountSnapshot,
  spec: Record<string, { pk: anchor.web3.PublicKey; strict?: boolean }>,
) {
  return Object.fromEntries(
    Object.entries(spec).map(([key, { pk, strict }]) => [
      key,
      h_getAmountBeforeAfter(before, after, pk, { strict }),
    ]),
  ) as Record<string, [bigint, bigint]>;
}

export function bondingCurveSell(
  decimals: number,
  reserveRatioBps: number,
  supply: number,
  reserve: number,
  amount: number,
): number {
  if (amount <= 0) return 0;
  if (amount > supply) throw new Error("sell amount exceeds supply");

  const alpha = reserveRatioBps / 10_000;
  if (alpha <= 0) throw new Error("alpha must be > 0");

  const scale = 10 ** decimals;

  const k = reserve / (supply / scale) ** (1 / alpha);

  const sBase = (supply - amount) / scale;
  const rNew = k * sBase ** (1 / alpha);
  const deltaR = reserve - rNew;

  if (!Number.isFinite(deltaR) || deltaR <= 0) return 0;

  return Math.floor(deltaR);
}

export function simulateSell(params: {
  decimals: number;
  amount: bigint;
  supply: bigint;
  reserve: bigint;
  reserveRatioBps: number;
  baseFeeBps: number;
}): SellSimulationResult {
  const { decimals, amount, supply, reserve, reserveRatioBps, baseFeeBps } =
    params;

  const feeCt = (amount * BigInt(baseFeeBps)) / 10_000n;
  const burnedCt = amount - feeCt;

  const userRtNum = bondingCurveSell(
    decimals,
    reserveRatioBps,
    Number(supply),
    Number(reserve),
    Number(burnedCt),
  );

  const userRt = BigInt(userRtNum);

  return {
    feeCt,
    burnedCt,
    netCt: amount,
    userRt,
  };
}

export async function setupBuyersAndBuy(
  program: anchor.Program<ContinuousToken>,
  provider: anchor.AnchorProvider,
  addrs: ProgramAddresses,
  mintRt: anchor.web3.PublicKey,
  buyerCfg: BuyerSpec[] = [],
): Promise<User[]> {
  const result: User[] = [];

  for (const bc of buyerCfg) {
    const opts = {
      rtAmount:
        bc.rtToDeposit === undefined ? undefined : Number(bc.rtToDeposit),
      sol: bc.solToDeposit === undefined ? undefined : Number(bc.solToDeposit),
    };
    const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, opts);

    await program.methods
      .buy(new BN(bc.rtToBuy))
      .accountsStrict(buyAccounts(addrs, mintRt, buyer))
      .signers([buyer.keypair])
      .rpc();

    result.push(buyer);
  }

  return result;
}

function ata(
  mint: anchor.web3.PublicKey,
  owner: anchor.web3.PublicKey,
  tokenProgram = anchor.utils.token.TOKEN_PROGRAM_ID,
) {
  return getAssociatedTokenAddressSync(
    mint,
    owner,
    true,
    tokenProgram,
    anchor.utils.token.ASSOCIATED_PROGRAM_ID,
  );
}

function getConfigPdaAddress(
  seed: anchor.BN,
  programId: anchor.web3.PublicKey,
): PdaWithBump {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config"), seed.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

function getCtMintPdaAddress(
  seed: anchor.BN,
  programId: anchor.web3.PublicKey,
): PdaWithBump {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("ct"), seed.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

function getFeeVaultLockedPdaAddress(
  seed: anchor.BN,
  programId: anchor.web3.PublicKey,
): PdaWithBump {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault"), seed.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

export async function devnet_transferSol(
  provider: anchor.AnchorProvider,
  to: anchor.web3.PublicKey,
  lamports: number,
): Promise<void> {
  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: to,
      lamports,
    }),
  );
  await provider.sendAndConfirm(tx);
}

export async function devnet_drainSolTo(
  provider: anchor.AnchorProvider,
  keypair: anchor.web3.Keypair,
  destination: anchor.web3.PublicKey,
): Promise<void> {
  const balance = await provider.connection.getBalance(keypair.publicKey);
  const fee = 5000;
  const rentExempt =
    await provider.connection.getMinimumBalanceForRentExemption(0);
  const sendable = balance - rentExempt - fee;
  if (sendable <= 0) return;

  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: destination,
      lamports: sendable,
    }),
  );
  await provider.sendAndConfirm(tx, [keypair]);
}

export async function devnet_closeAta(
  provider: anchor.AnchorProvider,
  ata: anchor.web3.PublicKey,
  owner: anchor.web3.Keypair,
  destination: anchor.web3.PublicKey,
): Promise<void> {
  try {
    await closeAccount(provider.connection, owner, ata, destination, owner);
  } catch {
    // ignore
  }
}
