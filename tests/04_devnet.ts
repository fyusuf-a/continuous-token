import type { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { expect } from "chai";
import type { ContinuousToken } from "../target/types/continuous_token";
import {
  BNtoBigInt,
  buyAccounts,
  DEFAULT_INIT_CONFIG,
  deriveProgramAddresses,
  devnet_closeAta,
  devnet_drainSolTo,
  devnet_transferSol,
  h_getMintAuto,
  h_getTokenAccountsAuto,
  h_getTokenAuto,
  type InitializeConfig,
  initializeProgram,
  RT_DECIMALS,
  sellAccounts,
  simulateBuy,
  simulateSell,
  snapshotAmountBeforeAfter,
} from "./helpers";

const SOL_PER_USER = 0.1 * anchor.web3.LAMPORTS_PER_SOL; // 0.1 SOL each
const RT_PER_USER = 10 * 10 ** RT_DECIMALS; // 10 RT tokens

describe("Devnet Happy Path @devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.continuousToken as Program<ContinuousToken>;
  const wallet = provider.wallet as anchor.Wallet;

  let mintRt: anchor.web3.PublicKey;
  let addrs: Awaited<ReturnType<typeof deriveProgramAddresses>>;
  let cfg: InitializeConfig;

  let user: anchor.web3.Keypair;
  let referrer: anchor.web3.Keypair;
  let userRtAta: anchor.web3.PublicKey;
  let userCtAta: anchor.web3.PublicKey;
  let referrerCtAta: anchor.web3.PublicKey;

  const seed = new BN(Math.floor(Math.random() * 1_000_000));

  before("Fund accounts + Initialize program", async () => {
    user = anchor.web3.Keypair.generate();
    referrer = anchor.web3.Keypair.generate();

    await devnet_transferSol(provider, user.publicKey, SOL_PER_USER);
    await devnet_transferSol(provider, referrer.publicKey, SOL_PER_USER);

    mintRt = await createMint(
      provider.connection,
      wallet.payer,
      wallet.publicKey,
      null,
      RT_DECIMALS,
    );

    cfg = { ...DEFAULT_INIT_CONFIG, seed };
    addrs = await deriveProgramAddresses(seed, mintRt, program.programId);

    const userRtAtaInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mintRt,
      user.publicKey,
    );
    userRtAta = userRtAtaInfo.address;

    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mintRt,
      referrer.publicKey,
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mintRt,
      userRtAta,
      wallet.payer,
      RT_PER_USER,
    );

    await initializeProgram(program, provider, addrs, mintRt, cfg);

    const userCtAtaInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      addrs.ctMintPda,
      user.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
      anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    );
    userCtAta = userCtAtaInfo.address;

    const referrerCtAtaInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      addrs.ctMintPda,
      referrer.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
      anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    );
    referrerCtAta = referrerCtAtaInfo.address;
  });

  after("Drain accounts back to main", async () => {
    const destination = wallet.publicKey;

    // Close user token accounts
    await devnet_closeAta(provider, userRtAta, user, destination);
    await devnet_closeAta(provider, userCtAta, user, destination);
    await devnet_closeAta(
      provider,
      getAssociatedTokenAddressSync(mintRt, referrer.publicKey),
      referrer,
      destination,
    );
    await devnet_closeAta(provider, referrerCtAta, referrer, destination);

    // Drain remaining SOL
    await devnet_drainSolTo(provider, user, destination);
    await devnet_drainSolTo(provider, referrer, destination);
  });

  it("Buy with referrer succeeeds", async () => {
    const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);

    const buyerUser = {
      keypair: user,
      publicKey: user.publicKey,
      RtAta: userRtAta,
      CtAta: userCtAta,
    };
    const buyerReferrer = {
      keypair: referrer,
      publicKey: referrer.publicKey,
      RtAta: getAssociatedTokenAddressSync(mintRt, referrer.publicKey),
      CtAta: referrerCtAta,
    };

    // Snapshot before
    const snapshotBefore = await h_getTokenAccountsAuto(
      provider.connection,
      [
        userRtAta,
        userCtAta,
        referrerCtAta,
        addrs.vaultRt,
        addrs.vaultCtLocked,
        addrs.ctMintPda,
      ],
      { strict: false },
    );

    // Call
    await program.methods
      .buy(RT_AMOUNT)
      .accountsStrict(buyAccounts(addrs, mintRt, buyerUser, buyerReferrer))
      .signers([user])
      .rpc();

    const simBuy = simulateBuy({
      decimals: h_getMintAuto(snapshotBefore, addrs.ctMintPda).decimals,
      amount: BigInt(RT_AMOUNT.toString()),
      reserve: h_getTokenAuto(snapshotBefore, addrs.vaultRt).amount,
      supply: h_getMintAuto(snapshotBefore, addrs.ctMintPda).supply,
      hasReferrer: true,
      firstPrice: BigInt(cfg.curve.firstPrice.toString()),
      reserveRatioBps: cfg.curve.reserveRatioBps,
      discountBps: cfg.curve.discountBps,
      baseFeeBps: cfg.curve.baseFeeBps,
    });

    // Snapshot after
    const snapshotAfter = await h_getTokenAccountsAuto(
      provider.connection,
      [
        userRtAta,
        userCtAta,
        referrerCtAta,
        addrs.vaultRt,
        addrs.vaultCtLocked,
        addrs.ctMintPda,
      ],
      { strict: false },
    );

    const {
      buyerRt: [buyerRtBefore, buyerRtAfter],
      buyerCt: [buyerCtBefore, buyerCtAfter],
      referrerCt: [referrerCtBefore, referrerCtAfter],
      vaultRt: [vaultRtBefore, vaultRtAfter],
      vaultCtLocked: [vaultCtLockedBefore, vaultCtLockedAfter],
      mintCt: [mintCtBefore, mintCtAfter],
    } = snapshotAmountBeforeAfter(snapshotBefore, snapshotAfter, {
      buyerRt: { pk: userRtAta },
      buyerCt: { pk: userCtAta, strict: false },
      referrerCt: { pk: referrerCtAta, strict: false },
      vaultRt: { pk: addrs.vaultRt },
      vaultCtLocked: { pk: addrs.vaultCtLocked, strict: false },
      mintCt: { pk: addrs.ctMintPda },
    });

    // Checks
    expect(buyerRtBefore - buyerRtAfter).to.eq(BNtoBigInt(RT_AMOUNT));
    expect(buyerCtAfter - buyerCtBefore).to.eq(simBuy.userCt);
    expect(vaultRtAfter - vaultRtBefore).to.eq(BNtoBigInt(RT_AMOUNT));
    expect(vaultCtLockedAfter - vaultCtLockedBefore).to.eq(
      simBuy.lockedVaultCt,
    );
    expect(referrerCtAfter - referrerCtBefore).to.eq(simBuy.referrerCt);
    expect(mintCtAfter - mintCtBefore).to.eq(
      simBuy.userCt + simBuy.lockedVaultCt + simBuy.referrerCt,
    );
    expect(
      buyerCtAfter -
        buyerCtBefore +
        (referrerCtAfter - referrerCtBefore) +
        (vaultCtLockedAfter - vaultCtLockedBefore),
    ).to.eq(mintCtAfter - mintCtBefore);
  });

  it("Sell (partial) succeeds", async () => {
    const seller = {
      keypair: user,
      publicKey: user.publicKey,
      RtAta: userRtAta,
      CtAta: userCtAta,
    };

    // Snapshot before
    const snapshotBefore = await h_getTokenAccountsAuto(
      provider.connection,
      [
        userRtAta,
        userCtAta,
        addrs.vaultRt,
        addrs.vaultCtLocked,
        addrs.ctMintPda,
      ],
      { strict: false },
    );

    const CT_AMOUNT =
      h_getTokenAuto(snapshotBefore, userCtAta).amount / BigInt(2);
    const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

    // Call
    const simSell = simulateSell({
      decimals: h_getMintAuto(snapshotBefore, addrs.ctMintPda).decimals,
      amount: CT_AMOUNT,
      reserve: h_getTokenAuto(snapshotBefore, addrs.vaultRt).amount,
      supply: h_getMintAuto(snapshotBefore, addrs.ctMintPda).supply,
      reserveRatioBps: cfg.curve.reserveRatioBps,
      baseFeeBps: cfg.curve.baseFeeBps,
    });

    await program.methods
      .sell(CT_AMOUNT_BN)
      .accountsStrict(sellAccounts(addrs, mintRt, seller))
      .signers([user])
      .rpc();

    // Snapshot after
    const snapshotAfter = await h_getTokenAccountsAuto(
      provider.connection,
      [
        userRtAta,
        userCtAta,
        addrs.vaultRt,
        addrs.vaultCtLocked,
        addrs.ctMintPda,
      ],
      { strict: false },
    );

    const {
      sellerCt: [sellerCtBefore, sellerCtAfter],
      sellerRt: [sellerRtBefore, sellerRtAfter],
      vaultRt: [vaultRtBefore, vaultRtAfter],
      vaultCtLocked: [vaultCtLockedBefore, vaultCtLockedAfter],
      mintCt: [mintCtBefore, mintCtAfter],
    } = snapshotAmountBeforeAfter(snapshotBefore, snapshotAfter, {
      sellerRt: { pk: userRtAta },
      sellerCt: { pk: userCtAta, strict: false },
      vaultRt: { pk: addrs.vaultRt },
      vaultCtLocked: { pk: addrs.vaultCtLocked, strict: false },
      mintCt: { pk: addrs.ctMintPda },
    });

    // Checks
    expect(sellerCtBefore - sellerCtAfter).to.eq(CT_AMOUNT);
    expect(sellerRtAfter - sellerRtBefore).to.eq(simSell.userRt);
    expect(vaultRtBefore - vaultRtAfter).to.eq(simSell.userRt);
    expect(vaultCtLockedAfter - vaultCtLockedBefore).to.eq(simSell.feeCt);
    expect(mintCtBefore - mintCtAfter).to.eq(simSell.burnedCt);
    expect(sellerCtBefore - sellerCtAfter).to.eq(
      mintCtBefore - mintCtAfter + (vaultCtLockedAfter - vaultCtLockedBefore),
    );
  });
});
