import type { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import {
  createCloseAccountInstruction,
  createMint,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { expect } from "chai";
import type { ContinuousToken } from "../target/types/continuous_token";
import {
  airdrop,
  airdropRT,
  DEFAULT_INIT_CONFIG,
  deriveProgramAddresses,
  drainATAs,
  drainSol,
  getAccountAuto_single,
  h_getMintAuto,
  h_getTokenAccountsAuto,
  h_getTokenAuto,
  type InitializeConfig,
  initializeProgram,
  type ProgramAddresses,
  RT_DECIMALS,
  randomBN,
  sellAccounts,
  setupBuyersAndBuy,
  setupUser,
  simulateSell,
  snapshotAmountBeforeAfter,
} from "./helpers";

describe("Sell", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.continuousToken as Program<ContinuousToken>;

  const initializer = provider.wallet.publicKey;
  let mintRt: anchor.web3.PublicKey;
  let addrs: ProgramAddresses;

  const seed = randomBN(1000);
  const cfg: InitializeConfig = {
    ...DEFAULT_INIT_CONFIG,
    seed,
  };

  let mintRt_fake: anchor.web3.PublicKey;
  let addrs_fake: ProgramAddresses;

  const seed_fake = randomBN(1000);
  const cfg_fake: InitializeConfig = {
    ...DEFAULT_INIT_CONFIG,
    seed: seed_fake,
  };

  before(async () => {
    await airdrop(provider, initializer);

    mintRt = await createMint(
      provider.connection,
      provider.wallet.payer,
      initializer,
      null,
      RT_DECIMALS,
    );
    mintRt_fake = await createMint(
      provider.connection,
      provider.wallet.payer,
      initializer,
      null,
      RT_DECIMALS,
    );

    await airdropRT(provider, mintRt, initializer);

    addrs = await deriveProgramAddresses(seed, mintRt, program.programId);
    addrs_fake = await deriveProgramAddresses(
      seed_fake,
      mintRt_fake,
      program.programId,
    );

    await initializeProgram(program, provider, addrs, mintRt, cfg);
    await initializeProgram(
      program,
      provider,
      addrs_fake,
      mintRt_fake,
      cfg_fake,
    );
  });

  describe("Sell fails", () => {
    it("Insufficient CT balance", async () => {
      // Setup
      const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
      const [seller] = await setupBuyersAndBuy(
        program,
        provider,
        addrs,
        mintRt,
        [
          {
            rtToDeposit: BigInt(RT_AMOUNT.toString()),
            rtToBuy: BigInt(RT_AMOUNT.toString()),
          },
        ],
      );

      const CT_AMOUNT =
        (await getAccountAuto_single(provider.connection, seller.CtAta))
          .amount * BigInt(2);
      const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

      try {
        await program.methods
          .sell(CT_AMOUNT_BN)
          .accountsStrict(sellAccounts(addrs, mintRt, seller))
          .signers([seller.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "InsufficientBalance",
          number: 6003,
        });
      }
    });

    it("Insufficient SOL for ATA creation", async () => {
      // Setup
      const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
      const [seller] = await setupBuyersAndBuy(
        program,
        provider,
        addrs,
        mintRt,
        [
          {
            rtToDeposit: BigInt(RT_AMOUNT.toString()),
            rtToBuy: BigInt(RT_AMOUNT.toString()),
          },
        ],
      );

      const CT_AMOUNT = (
        await getAccountAuto_single(provider.connection, seller.CtAta)
      ).amount;
      const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

      const rentLamports =
        await provider.connection.getMinimumBalanceForRentExemption(0);
      await drainATAs(provider, seller.keypair, undefined, [mintRt], 0n);
      const sellerRtAta = getAssociatedTokenAddressSync(
        mintRt,
        seller.keypair.publicKey,
      );
      const closeTx = new anchor.web3.Transaction().add(
        createCloseAccountInstruction(
          sellerRtAta,
          provider.wallet.publicKey,
          seller.keypair.publicKey,
        ),
      );
      await provider.sendAndConfirm(closeTx, [seller.keypair]);
      await drainSol(provider, seller.keypair, undefined, rentLamports);

      try {
        await program.methods
          .sell(CT_AMOUNT_BN)
          .accountsStrict(sellAccounts(addrs, mintRt, seller))
          .signers([seller.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.toString()).to.match(
          /Transfer: insufficient lamports \d+, need \d+/,
        );
      }
    });

    it("No CT ATA", async () => {
      const seller = await setupUser(provider, mintRt, addrs.ctMintPda);

      const CT_AMOUNT = 1n;
      const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

      try {
        await program.methods
          .sell(CT_AMOUNT_BN)
          .accountsStrict(sellAccounts(addrs, mintRt, seller))
          .signers([seller.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "AccountNotInitialized",
          number: 3012,
        });
      }
    });

    it("Passing incorrect mint", async () => {
      // Setup
      const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
      const [seller] = await setupBuyersAndBuy(
        program,
        provider,
        addrs,
        mintRt,
        [
          {
            rtToDeposit: BigInt(RT_AMOUNT.toString()),
            rtToBuy: BigInt(RT_AMOUNT.toString()),
          },
        ],
      );

      const CT_AMOUNT = (
        await getAccountAuto_single(provider.connection, seller.CtAta)
      ).amount;
      const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

      try {
        await program.methods
          .sell(CT_AMOUNT_BN)
          .accountsStrict(sellAccounts(addrs, mintRt_fake, seller))
          .signers([seller.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "ConstraintTokenMint",
          number: 2014,
        });
      }
    });

    it("Passing incorrect token program for CT", async () => {
      // Setup
      const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
      const [seller] = await setupBuyersAndBuy(
        program,
        provider,
        addrs,
        mintRt,
        [
          {
            rtToDeposit: BigInt(RT_AMOUNT.toString()),
            rtToBuy: BigInt(RT_AMOUNT.toString()),
          },
        ],
      );

      const CT_AMOUNT = (
        await getAccountAuto_single(provider.connection, seller.CtAta)
      ).amount;
      const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

      try {
        await program.methods
          .sell(CT_AMOUNT_BN)
          .accountsStrict({
            ...sellAccounts(addrs, mintRt, seller),
            tokenProgramCt: anchor.utils.token.TOKEN_PROGRAM_ID,
          })
          .signers([seller.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "ConstraintMintTokenProgram",
          number: 2022,
        });
      }
    });

    it("Passing incorrect token program for RT", async () => {
      // Setup
      const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
      const [seller] = await setupBuyersAndBuy(
        program,
        provider,
        addrs,
        mintRt,
        [
          {
            rtToDeposit: BigInt(RT_AMOUNT.toString()),
            rtToBuy: BigInt(RT_AMOUNT.toString()),
          },
        ],
      );

      const CT_AMOUNT = (
        await getAccountAuto_single(provider.connection, seller.CtAta)
      ).amount;
      const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

      try {
        await program.methods
          .sell(CT_AMOUNT_BN)
          .accountsStrict({
            ...sellAccounts(addrs, mintRt, seller),
            tokenProgramRt: TOKEN_2022_PROGRAM_ID,
          })
          .signers([seller.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "ConstraintAssociatedTokenTokenProgram",
          number: 2023,
        });
      }
    });

    it("Passing wrong config PDA", async () => {
      // Setup
      const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
      const [seller] = await setupBuyersAndBuy(
        program,
        provider,
        addrs,
        mintRt,
        [
          {
            rtToDeposit: BigInt(RT_AMOUNT.toString()),
            rtToBuy: BigInt(RT_AMOUNT.toString()),
          },
        ],
      );

      const CT_AMOUNT = 0n;
      const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

      try {
        await program.methods
          .sell(CT_AMOUNT_BN)
          .accountsStrict({
            ...sellAccounts(addrs, mintRt, seller),
            config: addrs_fake.configPda,
          })
          .signers([seller.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "IncorrectMint",
          number: 6008,
        });
      }
    });

    it("Passing wrong fee vault authority PDA", async () => {
      // Setup
      const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
      const [seller] = await setupBuyersAndBuy(
        program,
        provider,
        addrs,
        mintRt,
        [
          {
            rtToDeposit: BigInt(RT_AMOUNT.toString()),
            rtToBuy: BigInt(RT_AMOUNT.toString()),
          },
        ],
      );

      const CT_AMOUNT = 0n;
      const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

      try {
        await program.methods
          .sell(CT_AMOUNT_BN)
          .accountsStrict({
            ...sellAccounts(addrs, mintRt, seller),
            feeVaultAuthority: addrs_fake.feeVaultLockedPda,
          })
          .signers([seller.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "ConstraintTokenOwner",
          number: 2015,
        });
      }
    });

    it("Selling zero tokens", async () => {
      // Setup
      const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
      const [seller] = await setupBuyersAndBuy(
        program,
        provider,
        addrs,
        mintRt,
        [
          {
            rtToDeposit: BigInt(RT_AMOUNT.toString()),
            rtToBuy: BigInt(RT_AMOUNT.toString()),
          },
        ],
      );

      const CT_AMOUNT = 0n;
      const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

      try {
        await program.methods
          .sell(CT_AMOUNT_BN)
          .accountsStrict(sellAccounts(addrs, mintRt, seller))
          .signers([seller.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "InvalidAmount",
          number: 6004,
        });
      }
    });
  });

  it("Sell (single - full) succeeds", async () => {
    // Setup
    const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
    const [seller] = await setupBuyersAndBuy(program, provider, addrs, mintRt, [
      {
        rtToDeposit: BigInt(RT_AMOUNT.toString()),
        rtToBuy: BigInt(RT_AMOUNT.toString()),
      },
    ]);

    // State before
    const snapshotBefore = await h_getTokenAccountsAuto(
      provider.connection,
      [
        seller.RtAta,
        seller.CtAta,
        addrs.vaultRt,
        addrs.vaultCtUnlocked,
        addrs.vaultCtLocked,
        addrs.ctMintPda,
      ],
      { strict: false },
    );

    const CT_AMOUNT = h_getTokenAuto(snapshotBefore, seller.CtAta).amount;
    const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

    // Call
    const simSellResult = simulateSell({
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
      .signers([seller.keypair])
      .rpc();

    // State
    const snapshotAfter = await h_getTokenAccountsAuto(
      provider.connection,
      [
        seller.RtAta,
        seller.CtAta,
        addrs.vaultRt,
        addrs.vaultCtUnlocked,
        addrs.vaultCtLocked,
        addrs.ctMintPda,
      ],
      { strict: false },
    );

    // Check
    const {
      sellerCt: [sellerCtBefore, sellerCtAfter],
      sellerRt: [sellerRtBefore, sellerRtAfter],
      vaultCtLocked: [vaultCtLockedBefore, vaultCtLockedAfter],
      vaultCtUnlocked: [vaultCtUnlockedBefore, vaultCtUnlockedAfter],
      vaultRt: [vaultRtBefore, vaultRtAfter],
      mintCt: [mintCtBefore, mintCtAfter],
    } = snapshotAmountBeforeAfter(snapshotBefore, snapshotAfter, {
      sellerRt: { pk: seller.RtAta },
      sellerCt: { pk: seller.CtAta, strict: false },
      vaultRt: { pk: addrs.vaultRt },
      vaultCtLocked: { pk: addrs.vaultCtLocked, strict: false },
      vaultCtUnlocked: { pk: addrs.vaultCtUnlocked, strict: false },
      mintCt: { pk: addrs.ctMintPda },
    });

    expect(sellerCtBefore - sellerCtAfter).to.eq(CT_AMOUNT);
    expect(sellerRtAfter - sellerRtBefore).to.eq(simSellResult.userRt);
    expect(vaultRtBefore - vaultRtAfter).to.eq(simSellResult.userRt);
    expect(vaultCtLockedAfter - vaultCtLockedBefore).to.eq(simSellResult.feeCt);
    expect(vaultCtUnlockedAfter - vaultCtUnlockedBefore).to.eq(0n);
    expect(mintCtBefore - mintCtAfter).to.eq(simSellResult.burnedCt);
    expect(sellerCtBefore - sellerCtAfter).to.eq(
      mintCtBefore -
        mintCtAfter +
        (vaultCtLockedAfter - vaultCtLockedBefore) +
        (vaultCtUnlockedAfter - vaultCtUnlockedBefore),
    );
  });

  it("Sell (single - partial) succeeds", async () => {
    // Setup
    const PORTIONS = BigInt(3);
    const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
    const [seller] = await setupBuyersAndBuy(program, provider, addrs, mintRt, [
      {
        rtToDeposit: BigInt(RT_AMOUNT.toString()),
        rtToBuy: BigInt(RT_AMOUNT.toString()),
      },
    ]);

    // State before
    const snapshotBefore = await h_getTokenAccountsAuto(
      provider.connection,
      [
        seller.RtAta,
        seller.CtAta,
        addrs.vaultRt,
        addrs.vaultCtUnlocked,
        addrs.vaultCtLocked,
        addrs.ctMintPda,
      ],
      { strict: false },
    );

    const CT_AMOUNT =
      h_getTokenAuto(snapshotBefore, seller.CtAta).amount / PORTIONS;
    const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

    // Call
    const simSellResult = simulateSell({
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
      .signers([seller.keypair])
      .rpc();

    // State
    const snapshotAfter = await h_getTokenAccountsAuto(
      provider.connection,
      [
        seller.RtAta,
        seller.CtAta,
        addrs.vaultRt,
        addrs.vaultCtUnlocked,
        addrs.vaultCtLocked,
        addrs.ctMintPda,
      ],
      { strict: false },
    );

    // Check
    const {
      sellerCt: [sellerCtBefore, sellerCtAfter],
      sellerRt: [sellerRtBefore, sellerRtAfter],
      vaultCtLocked: [vaultCtLockedBefore, vaultCtLockedAfter],
      vaultCtUnlocked: [vaultCtUnlockedBefore, vaultCtUnlockedAfter],
      vaultRt: [vaultRtBefore, vaultRtAfter],
      mintCt: [mintCtBefore, mintCtAfter],
    } = snapshotAmountBeforeAfter(snapshotBefore, snapshotAfter, {
      sellerRt: { pk: seller.RtAta },
      sellerCt: { pk: seller.CtAta, strict: false },
      vaultRt: { pk: addrs.vaultRt },
      vaultCtLocked: { pk: addrs.vaultCtLocked, strict: false },
      vaultCtUnlocked: { pk: addrs.vaultCtUnlocked, strict: false },
      mintCt: { pk: addrs.ctMintPda },
    });

    expect(sellerCtBefore - sellerCtAfter).to.eq(CT_AMOUNT);
    expect(sellerRtAfter - sellerRtBefore).to.eq(simSellResult.userRt);
    expect(vaultRtBefore - vaultRtAfter).to.eq(simSellResult.userRt);
    expect(vaultCtLockedAfter - vaultCtLockedBefore).to.eq(simSellResult.feeCt);
    expect(vaultCtUnlockedAfter - vaultCtUnlockedBefore).to.eq(0n);
    expect(mintCtBefore - mintCtAfter).to.eq(simSellResult.burnedCt);
    expect(sellerCtBefore - sellerCtAfter).to.eq(
      mintCtBefore -
        mintCtAfter +
        (vaultCtLockedAfter - vaultCtLockedBefore) +
        (vaultCtUnlockedAfter - vaultCtUnlockedBefore),
    );
  });

  it("Sell (multiple - same account) succeeds", async () => {
    // Setup
    const LOOPS = 10;
    const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
    const [seller] = await setupBuyersAndBuy(program, provider, addrs, mintRt, [
      {
        rtToDeposit: BigInt(RT_AMOUNT.toString()),
        rtToBuy: BigInt(RT_AMOUNT.toString()),
      },
    ]);

    const CT_AMOUNT =
      (await getAccountAuto_single(provider.connection, seller.CtAta)).amount /
      BigInt(LOOPS);
    const CT_AMOUNT_BN = new BN(CT_AMOUNT.toString());

    for (let i = 0; i < LOOPS; i++) {
      // State before
      const snapshotBefore = await h_getTokenAccountsAuto(
        provider.connection,
        [
          seller.RtAta,
          seller.CtAta,
          addrs.vaultRt,
          addrs.vaultCtUnlocked,
          addrs.vaultCtLocked,
          addrs.ctMintPda,
        ],
        { strict: false },
      );

      // Call
      const simSellResult = simulateSell({
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
        .signers([seller.keypair])
        .rpc();

      // State
      const snapshotAfter = await h_getTokenAccountsAuto(
        provider.connection,
        [
          seller.RtAta,
          seller.CtAta,
          addrs.vaultRt,
          addrs.vaultCtUnlocked,
          addrs.vaultCtLocked,
          addrs.ctMintPda,
        ],
        { strict: false },
      );

      // Check
      const {
        sellerCt: [sellerCtBefore, sellerCtAfter],
        sellerRt: [sellerRtBefore, sellerRtAfter],
        vaultCtLocked: [vaultCtLockedBefore, vaultCtLockedAfter],
        vaultCtUnlocked: [vaultCtUnlockedBefore, vaultCtUnlockedAfter],
        vaultRt: [vaultRtBefore, vaultRtAfter],
        mintCt: [mintCtBefore, mintCtAfter],
      } = snapshotAmountBeforeAfter(snapshotBefore, snapshotAfter, {
        sellerRt: { pk: seller.RtAta },
        sellerCt: { pk: seller.CtAta, strict: false },
        vaultRt: { pk: addrs.vaultRt },
        vaultCtLocked: { pk: addrs.vaultCtLocked, strict: false },
        vaultCtUnlocked: { pk: addrs.vaultCtUnlocked, strict: false },
        mintCt: { pk: addrs.ctMintPda },
      });

      expect(sellerCtBefore - sellerCtAfter).to.eq(CT_AMOUNT);
      expect(sellerRtAfter - sellerRtBefore).to.eq(simSellResult.userRt);
      expect(vaultRtBefore - vaultRtAfter).to.eq(simSellResult.userRt);
      expect(vaultCtLockedAfter - vaultCtLockedBefore).to.eq(
        simSellResult.feeCt,
      );
      expect(vaultCtUnlockedAfter - vaultCtUnlockedBefore).to.eq(0n);
      expect(mintCtBefore - mintCtAfter).to.eq(simSellResult.burnedCt);
      expect(sellerCtBefore - sellerCtAfter).to.eq(
        mintCtBefore -
          mintCtAfter +
          (vaultCtLockedAfter - vaultCtLockedBefore) +
          (vaultCtUnlockedAfter - vaultCtUnlockedBefore),
      );
    }
  });

  it("Sell (multiple - different accounts) succeeds", async () => {
    // Setup
    const LOOPS = 5;
    const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
    const [sellerA, sellerB] = await setupBuyersAndBuy(
      program,
      provider,
      addrs,
      mintRt,
      [
        {
          rtToDeposit: BigInt(RT_AMOUNT.toString()),
          rtToBuy: BigInt(RT_AMOUNT.toString()),
        },
        {
          rtToDeposit: BigInt(RT_AMOUNT.toString()),
          rtToBuy: BigInt(RT_AMOUNT.toString()),
        },
      ],
    );

    const CT_AMOUNT_A =
      (await getAccountAuto_single(provider.connection, sellerA.CtAta)).amount /
      BigInt(LOOPS);
    const CT_AMOUNT_A_BN = new BN(CT_AMOUNT_A.toString());

    const CT_AMOUNT_B =
      (await getAccountAuto_single(provider.connection, sellerB.CtAta)).amount /
      BigInt(LOOPS);
    const CT_AMOUNT_B_BN = new BN(CT_AMOUNT_B.toString());

    for (let i = 0; i < LOOPS; i++) {
      for (const [seller, CT_AMOUNT, CT_AMOUNT_BN] of [
        [sellerA, CT_AMOUNT_A, CT_AMOUNT_A_BN],
        [sellerB, CT_AMOUNT_B, CT_AMOUNT_B_BN],
      ] as const) {
        // State
        const snapshotBefore = await h_getTokenAccountsAuto(
          provider.connection,
          [
            seller.RtAta,
            seller.CtAta,
            addrs.vaultRt,
            addrs.vaultCtUnlocked,
            addrs.vaultCtLocked,
            addrs.ctMintPda,
          ],
          { strict: false },
        );

        // Call
        const simSellResult = simulateSell({
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
          .signers([seller.keypair])
          .rpc();

        // State
        const snapshotAfter = await h_getTokenAccountsAuto(
          provider.connection,
          [
            seller.RtAta,
            seller.CtAta,
            addrs.vaultRt,
            addrs.vaultCtUnlocked,
            addrs.vaultCtLocked,
            addrs.ctMintPda,
          ],
          { strict: false },
        );

        // Check
        const {
          sellerCt: [sellerCtBefore, sellerCtAfter],
          sellerRt: [sellerRtBefore, sellerRtAfter],
          vaultCtLocked: [vaultCtLockedBefore, vaultCtLockedAfter],
          vaultCtUnlocked: [vaultCtUnlockedBefore, vaultCtUnlockedAfter],
          vaultRt: [vaultRtBefore, vaultRtAfter],
          mintCt: [mintCtBefore, mintCtAfter],
        } = snapshotAmountBeforeAfter(snapshotBefore, snapshotAfter, {
          sellerRt: { pk: seller.RtAta },
          sellerCt: { pk: seller.CtAta, strict: false },
          vaultRt: { pk: addrs.vaultRt },
          vaultCtLocked: { pk: addrs.vaultCtLocked, strict: false },
          vaultCtUnlocked: { pk: addrs.vaultCtUnlocked, strict: false },
          mintCt: { pk: addrs.ctMintPda },
        });

        expect(sellerCtBefore - sellerCtAfter).to.eq(CT_AMOUNT);
        expect(sellerRtAfter - sellerRtBefore).to.eq(simSellResult.userRt);
        expect(vaultRtBefore - vaultRtAfter).to.eq(simSellResult.userRt);
        expect(vaultCtLockedAfter - vaultCtLockedBefore).to.eq(
          simSellResult.feeCt,
        );
        expect(vaultCtUnlockedAfter - vaultCtUnlockedBefore).to.eq(0n);
        expect(mintCtBefore - mintCtAfter).to.eq(simSellResult.burnedCt);
        expect(sellerCtBefore - sellerCtAfter).to.eq(
          mintCtBefore -
            mintCtAfter +
            (vaultCtLockedAfter - vaultCtLockedBefore) +
            (vaultCtUnlockedAfter - vaultCtUnlockedBefore),
        );
      }
    }
  });
});
