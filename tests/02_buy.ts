import type { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { expect } from "chai";
import type { ContinuousToken } from "../target/types/continuous_token";
import {
  airdrop,
  airdropRT,
  BNtoBigInt,
  buyAccounts,
  DEFAULT_INIT_CONFIG,
  deriveProgramAddresses,
  drainSol,
  h_getMintAuto,
  h_getTokenAccountsAuto,
  h_getTokenAuto,
  type InitializeConfig,
  initializeProgram,
  type ProgramAddresses,
  RT_DECIMALS,
  randomBN,
  setupUser,
  simulateBuy,
  snapshotAmountBeforeAfter,
} from "./helpers";

describe("Buy", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.continuousToken as Program<ContinuousToken>;

  const initializer = provider.wallet.publicKey;
  let mintRt: anchor.web3.PublicKey;
  let addrs: ProgramAddresses;

  let mintRt_fake: anchor.web3.PublicKey;
  let addrs_fake: ProgramAddresses;

  const seed = randomBN(1000);
  const cfg: InitializeConfig = {
    ...DEFAULT_INIT_CONFIG,
    seed,
  };

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

  describe("Buy fails", () => {
    it("Referring to self", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });

      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict(buyAccounts(addrs, mintRt, buyer, buyer))
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "SelfReferralNotAllowed",
          number: 6007,
        });
      }
    });

    it("Passing incorrect mint", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });

      // Call
      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict(buyAccounts(addrs, mintRt_fake, buyer))
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "IncorrectMint",
          number: 6008,
        });
      }
    });

    it("Insufficient RT balance", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT) / 2,
      });

      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict(buyAccounts(addrs, mintRt, buyer))
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "InsufficientBalance",
          number: 6003,
        });
      }
    });

    it("No RT ATA", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: 0,
      });

      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict(buyAccounts(addrs, mintRt, buyer))
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "AccountNotInitialized",
          number: 3012,
        });
      }
    });

    it("Insufficient SOL for ATA creation", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });
      const rentLamports =
        await provider.connection.getMinimumBalanceForRentExemption(0);
      await drainSol(provider, buyer.keypair, undefined, rentLamports);

      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict(buyAccounts(addrs, mintRt, buyer))
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.toString()).to.match(
          /Transfer: insufficient lamports \d+, need \d+/,
        );
      }
    });

    it("Passing incorrect token program for RT", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });

      // Call
      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict({
            ...buyAccounts(addrs, mintRt, buyer),
            tokenProgramRt: TOKEN_2022_PROGRAM_ID,
          })
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "ConstraintMintTokenProgram",
          number: 2022,
        });
      }
    });

    it("Passing incorrect token program for CT", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });

      // Call
      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict({
            ...buyAccounts(addrs, mintRt, buyer),
            tokenProgramCt: anchor.utils.token.TOKEN_PROGRAM_ID,
          })
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.transactionMessage.toString()).to.match(
          /An account required by the instruction is missing/,
        );
      }
    });

    it("Price curve math overflows", async () => {
      // Setup
      const RT_AMOUNT = new BN(BigInt(2) ** BigInt(64) - BigInt(1)).divn(2);
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda);

      const acct = await getAccount(provider.connection, buyer.RtAta);

      const remaining = RT_AMOUNT.sub(new BN(acct.amount.toString()));
      const part1 = remaining.div(new BN(2));
      const part2 = remaining.sub(part1);

      await airdropRT(
        provider,
        mintRt,
        buyer.publicKey,
        BigInt(part1.toString()),
      );
      await airdropRT(
        provider,
        mintRt,
        buyer.publicKey,
        BigInt(part2.toString()),
      );

      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict(buyAccounts(addrs, mintRt, buyer))
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        // console.log(e);
        expect(e.error.errorCode).to.deep.eq({
          code: "Overflow",
          number: 6001,
        });
      }
    });

    it("Passing wrong fee vault authority PDA", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });

      // Call
      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict({
            ...buyAccounts(addrs, mintRt, buyer),
            feeVaultAuthority: addrs_fake.feeVaultLockedPda,
          })
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "ConstraintTokenOwner",
          number: 2015,
        });
      }
    });

    it("Passing wrong config PDA", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });

      // Call
      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict({
            ...buyAccounts(addrs, mintRt, buyer),
            config: addrs_fake.configPda,
          })
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "IncorrectMint",
          number: 6008,
        });
      }
    });

    it("Passing PDA as referrer", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });
      const [fakeReferrerPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("referrer"), buyer.publicKey.toBuffer()],
        program.programId,
      );
      const fakeReferrerPdaCtAta = await getAssociatedTokenAddress(
        mintRt,
        fakeReferrerPda,
        true,
      );

      // Call
      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict({
            ...buyAccounts(addrs, mintRt, buyer),
            referrer: fakeReferrerPda,
            referrerCtAta: fakeReferrerPdaCtAta,
          })
          .signers([buyer.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.transactionMessage.toString()).to.match(
          /An account required by the instruction is missing/,
        );
      }
    });

    it("Buying zero tokens", async () => {
      // Setup
      const RT_AMOUNT = new BN(1 * 10 ** RT_DECIMALS);
      const ZERO = RT_AMOUNT.sub(RT_AMOUNT);
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });

      try {
        await program.methods
          .buy(ZERO)
          .accountsStrict(buyAccounts(addrs, mintRt, buyer))
          .signers([buyer.keypair])
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

  describe("Buy passes", () => {
    it("Buy (no referrer) succeeds", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });

      // State
      const snapshotBefore = await h_getTokenAccountsAuto(
        provider.connection,
        [
          buyer.RtAta,
          buyer.CtAta,
          addrs.vaultRt,
          addrs.vaultCtUnlocked,
          addrs.vaultCtLocked,
          addrs.ctMintPda,
        ],
        { strict: false },
      );

      // Call
      await program.methods
        .buy(RT_AMOUNT)
        .accountsStrict(buyAccounts(addrs, mintRt, buyer))
        .signers([buyer.keypair])
        .rpc();

      const simBuyResult = simulateBuy({
        decimals: h_getMintAuto(snapshotBefore, addrs.ctMintPda).decimals,
        amount: BigInt(RT_AMOUNT.toString()),
        reserve: h_getTokenAuto(snapshotBefore, addrs.vaultRt).amount,
        supply: h_getMintAuto(snapshotBefore, addrs.ctMintPda).supply,
        hasReferrer: false,
        firstPrice: BigInt(cfg.curve.firstPrice.toString()),
        reserveRatioBps: cfg.curve.reserveRatioBps,
        discountBps: cfg.curve.discountBps,
        baseFeeBps: cfg.curve.baseFeeBps,
      });

      // State
      const snapshotAfter = await h_getTokenAccountsAuto(
        provider.connection,
        [
          buyer.RtAta,
          buyer.CtAta,
          addrs.vaultRt,
          addrs.vaultCtUnlocked,
          addrs.vaultCtLocked,
          addrs.ctMintPda,
        ],
        { strict: false },
      );

      // Check
      const {
        buyerCt: [buyerCtBefore, buyerCtAfter],
        buyerRt: [buyerRtBefore, buyerRtAfter],
        vaultCtLocked: [vaultCtLockedBefore, vaultCtLockedAfter],
        vaultCtUnlocked: [vaultCtUnlockedBefore, vaultCtUnlockedAfter],
        vaultRt: [vaultRtBefore, vaultRtAfter],
        mintCt: [mintCtBefore, mintCtAfter],
      } = snapshotAmountBeforeAfter(snapshotBefore, snapshotAfter, {
        buyerRt: { pk: buyer.RtAta },
        buyerCt: { pk: buyer.CtAta, strict: false },
        vaultRt: { pk: addrs.vaultRt },
        vaultCtLocked: { pk: addrs.vaultCtLocked, strict: false },
        vaultCtUnlocked: { pk: addrs.vaultCtUnlocked, strict: false },
        mintCt: { pk: addrs.ctMintPda },
      });

      expect(buyerRtBefore - buyerRtAfter).to.eq(BNtoBigInt(RT_AMOUNT));
      expect(buyerCtAfter - buyerCtBefore).to.eq(simBuyResult.userCt);
      expect(vaultRtAfter - vaultRtBefore).to.eq(BNtoBigInt(RT_AMOUNT));
      expect(vaultCtLockedAfter - vaultCtLockedBefore).to.eq(
        simBuyResult.lockedVaultCt,
      );
      expect(vaultCtUnlockedBefore + vaultCtUnlockedAfter).to.eq(0n);
      expect(mintCtAfter - mintCtBefore).to.eq(
        simBuyResult.userCt +
          simBuyResult.lockedVaultCt +
          simBuyResult.referrerCt,
      );
      expect(simBuyResult.referrerCt).to.eq(0n);
      expect(
        buyerCtAfter -
          buyerCtBefore +
          (vaultCtLockedAfter - vaultCtLockedBefore) +
          (vaultCtUnlockedAfter - vaultCtUnlockedBefore),
      ).to.eq(mintCtAfter - mintCtBefore);
    });

    it("Buy (referrer) succeeds", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });
      const referrer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });

      // State
      const snapshotBefore = await h_getTokenAccountsAuto(
        provider.connection,
        [
          buyer.RtAta,
          referrer.RtAta,
          addrs.vaultRt,
          addrs.vaultCtUnlocked,
          addrs.vaultCtLocked,
          addrs.ctMintPda,
        ],
        { strict: false },
      );

      // Call
      await program.methods
        .buy(RT_AMOUNT)
        .accountsStrict(buyAccounts(addrs, mintRt, buyer, referrer))
        .signers([buyer.keypair])
        .rpc();

      const simBuyResult = simulateBuy({
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

      // State
      const snapshotAfter = await h_getTokenAccountsAuto(
        provider.connection,
        [
          buyer.RtAta,
          buyer.CtAta,
          referrer.RtAta,
          referrer.CtAta,
          addrs.vaultRt,
          addrs.vaultCtUnlocked,
          addrs.vaultCtLocked,
          addrs.ctMintPda,
        ],
        { strict: false },
      );

      // Check
      const {
        buyerCt: [buyerCtBefore, buyerCtAfter],
        buyerRt: [buyerRtBefore, buyerRtAfter],
        referrerCt: [referrerCtBefore, referrerCtAfter],
        referrerRt: [referrerRtBefore, referrerRtAfter],
        vaultCtLocked: [vaultCtLockedBefore, vaultCtLockedAfter],
        vaultCtUnlocked: [vaultCtUnlockedBefore, vaultCtUnlockedAfter],
        vaultRt: [vaultRtBefore, vaultRtAfter],
        mintCt: [mintCtBefore, mintCtAfter],
      } = snapshotAmountBeforeAfter(snapshotBefore, snapshotAfter, {
        buyerRt: { pk: buyer.RtAta },
        buyerCt: { pk: buyer.CtAta, strict: false },
        referrerRt: { pk: referrer.RtAta },
        referrerCt: { pk: referrer.CtAta, strict: false },
        vaultRt: { pk: addrs.vaultRt },
        vaultCtLocked: { pk: addrs.vaultCtLocked, strict: false },
        vaultCtUnlocked: { pk: addrs.vaultCtUnlocked, strict: false },
        mintCt: { pk: addrs.ctMintPda },
      });

      expect(buyerRtBefore - buyerRtAfter).to.eq(BNtoBigInt(RT_AMOUNT));
      expect(buyerCtAfter - buyerCtBefore).to.eq(simBuyResult.userCt);
      expect(vaultRtAfter - vaultRtBefore).to.eq(BNtoBigInt(RT_AMOUNT));
      expect(vaultCtLockedAfter - vaultCtLockedBefore).to.eq(
        simBuyResult.lockedVaultCt,
      );
      expect(vaultCtUnlockedAfter - vaultCtUnlockedBefore).to.eq(0n);
      expect(referrerRtAfter - referrerRtBefore).to.eq(0n);
      expect(referrerCtAfter - referrerCtBefore).to.eq(simBuyResult.referrerCt);
      expect(mintCtAfter - mintCtBefore).to.eq(
        simBuyResult.userCt +
          simBuyResult.lockedVaultCt +
          simBuyResult.referrerCt,
      );
      expect(
        buyerCtAfter -
          buyerCtBefore +
          (referrerCtAfter - referrerCtBefore) +
          (vaultCtLockedAfter - vaultCtLockedBefore) +
          (vaultCtUnlockedAfter - vaultCtUnlockedBefore),
      ).to.eq(mintCtAfter - mintCtBefore);
    });

    it("Buy (multiple - same account - no referrer) succeeds", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT) * 4,
      });

      for (let i = 0; i < 4; i++) {
        // State
        const snapshotBefore = await h_getTokenAccountsAuto(
          provider.connection,
          [
            buyer.RtAta,
            buyer.CtAta,
            addrs.vaultRt,
            addrs.vaultCtUnlocked,
            addrs.vaultCtLocked,
            addrs.ctMintPda,
          ],
          { strict: false },
        );

        // Call
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict(buyAccounts(addrs, mintRt, buyer))
          .signers([buyer.keypair])
          .rpc();

        const simBuyResult = simulateBuy({
          decimals: h_getMintAuto(snapshotBefore, addrs.ctMintPda).decimals,
          amount: BigInt(RT_AMOUNT.toString()),
          reserve: h_getTokenAuto(snapshotBefore, addrs.vaultRt).amount,
          supply: h_getMintAuto(snapshotBefore, addrs.ctMintPda).supply,
          hasReferrer: false,
          firstPrice: BigInt(cfg.curve.firstPrice.toString()),
          reserveRatioBps: cfg.curve.reserveRatioBps,
          discountBps: cfg.curve.discountBps,
          baseFeeBps: cfg.curve.baseFeeBps,
        });

        // State
        const snapshotAfter = await h_getTokenAccountsAuto(
          provider.connection,
          [
            buyer.RtAta,
            buyer.CtAta,
            addrs.vaultRt,
            addrs.vaultCtUnlocked,
            addrs.vaultCtLocked,
            addrs.ctMintPda,
          ],
          { strict: false },
        );

        // Check
        const {
          buyerRt: [buyerRtBefore, buyerRtAfter],
          buyerCt: [buyerCtBefore, buyerCtAfter],
          vaultRt: [vaultRtBefore, vaultRtAfter],
          vaultCtUnlocked: [vaultCtUnlockedBefore, vaultCtUnlockedAfter],
          vaultCtLocked: [vaultCtLockedBefore, vaultCtLockedAfter],
          mintCt: [mintCtBefore, mintCtAfter],
        } = snapshotAmountBeforeAfter(snapshotBefore, snapshotAfter, {
          buyerRt: { pk: buyer.RtAta },
          buyerCt: { pk: buyer.CtAta, strict: false },
          vaultRt: { pk: addrs.vaultRt },
          vaultCtLocked: { pk: addrs.vaultCtLocked, strict: false },
          vaultCtUnlocked: { pk: addrs.vaultCtUnlocked, strict: false },
          mintCt: { pk: addrs.ctMintPda },
        });

        expect(buyerRtBefore - buyerRtAfter).to.eq(BNtoBigInt(RT_AMOUNT));
        expect(buyerCtAfter - buyerCtBefore).to.eq(simBuyResult.userCt);
        expect(vaultRtAfter - vaultRtBefore).to.eq(BNtoBigInt(RT_AMOUNT));
        expect(vaultCtLockedAfter - vaultCtLockedBefore).to.eq(
          simBuyResult.lockedVaultCt,
        );
        expect(vaultCtUnlockedAfter - vaultCtUnlockedBefore).to.eq(0n);
        expect(simBuyResult.referrerCt).to.eq(0n);
        expect(mintCtAfter - mintCtBefore).to.eq(
          simBuyResult.userCt +
            simBuyResult.lockedVaultCt +
            simBuyResult.referrerCt,
        );
        expect(
          buyerCtAfter -
            buyerCtBefore +
            (vaultCtLockedAfter - vaultCtLockedBefore) +
            (vaultCtUnlockedAfter - vaultCtUnlockedBefore),
        ).to.eq(mintCtAfter - mintCtBefore);
      }
    });

    it("Buy (multiple - different accounts - no referrer) succeeds", async () => {
      // Setup
      const RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
      const buyerA = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });
      const buyerB = await setupUser(provider, mintRt, addrs.ctMintPda, {
        rtAmount: Number(RT_AMOUNT),
      });

      for (const buyer of [buyerA, buyerB]) {
        // State
        const snapshotBefore = await h_getTokenAccountsAuto(
          provider.connection,
          [
            buyer.RtAta,
            buyer.CtAta,
            addrs.vaultRt,
            addrs.vaultCtUnlocked,
            addrs.vaultCtLocked,
            addrs.ctMintPda,
          ],
          { strict: false },
        );

        // Call
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict(buyAccounts(addrs, mintRt, buyer))
          .signers([buyer.keypair])
          .rpc();

        const simBuyResult = simulateBuy({
          decimals: h_getMintAuto(snapshotBefore, addrs.ctMintPda).decimals,
          amount: BigInt(RT_AMOUNT.toString()),
          reserve: h_getTokenAuto(snapshotBefore, addrs.vaultRt).amount,
          supply: h_getMintAuto(snapshotBefore, addrs.ctMintPda).supply,
          hasReferrer: false,
          firstPrice: BigInt(cfg.curve.firstPrice.toString()),
          reserveRatioBps: cfg.curve.reserveRatioBps,
          discountBps: cfg.curve.discountBps,
          baseFeeBps: cfg.curve.baseFeeBps,
        });

        // State
        const snapshotAfter = await h_getTokenAccountsAuto(
          provider.connection,
          [
            buyer.RtAta,
            buyer.CtAta,
            addrs.vaultRt,
            addrs.vaultCtUnlocked,
            addrs.vaultCtLocked,
            addrs.ctMintPda,
          ],
          { strict: false },
        );

        // Check
        const {
          buyerRt: [buyerRtBefore, buyerRtAfter],
          buyerCt: [buyerCtBefore, buyerCtAfter],
          vaultRt: [vaultRtBefore, vaultRtAfter],
          vaultCtUnlocked: [vaultCtUnlockedBefore, vaultCtUnlockedAfter],
          vaultCtLocked: [vaultCtLockedBefore, vaultCtLockedAfter],
          mintCt: [mintCtBefore, mintCtAfter],
        } = snapshotAmountBeforeAfter(snapshotBefore, snapshotAfter, {
          buyerRt: { pk: buyer.RtAta },
          buyerCt: { pk: buyer.CtAta },
          vaultRt: { pk: addrs.vaultRt },
          vaultCtUnlocked: { pk: addrs.vaultCtUnlocked, strict: false },
          vaultCtLocked: { pk: addrs.vaultCtLocked },
          mintCt: { pk: addrs.ctMintPda },
        });

        expect(buyerRtBefore - buyerRtAfter).to.eq(BNtoBigInt(RT_AMOUNT));
        expect(buyerCtAfter - buyerCtBefore).to.eq(simBuyResult.userCt);
        expect(vaultRtAfter - vaultRtBefore).to.eq(BNtoBigInt(RT_AMOUNT));
        expect(vaultCtLockedAfter - vaultCtLockedBefore).to.eq(
          simBuyResult.lockedVaultCt,
        );
        expect(vaultCtUnlockedAfter - vaultCtUnlockedBefore).to.eq(0n);
        expect(mintCtAfter - mintCtBefore).to.eq(
          simBuyResult.userCt +
            simBuyResult.lockedVaultCt +
            simBuyResult.referrerCt,
        );
        expect(
          buyerCtAfter -
            buyerCtBefore +
            (vaultCtLockedAfter - vaultCtLockedBefore) +
            (vaultCtUnlockedAfter - vaultCtUnlockedBefore),
        ).to.eq(mintCtAfter - mintCtBefore);
        expect(simBuyResult.referrerCt).to.eq(0n);
      }
    });
  });
});
