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
  User,
} from "./helpers";

describe("Buy with referrals @local", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.continuousToken as Program<ContinuousToken>;

  const initializer = provider.wallet.publicKey;
  let mintRt: anchor.web3.PublicKey;
  let addrs: ProgramAddresses;

  let buyer: User;
  let RT_AMOUNT: anchor.BN;

  let somebodyElse: User;

  const seed = randomBN(1000);
  const cfg: InitializeConfig = {
    ...DEFAULT_INIT_CONFIG,
    curve: {
      ...DEFAULT_INIT_CONFIG.curve,
      minBalanceForReferralBps: 5_000, // 50%
    },
    seed,
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

    await airdropRT(provider, mintRt, initializer);

    addrs = await deriveProgramAddresses(seed, mintRt, program.programId);

    await initializeProgram(program, provider, addrs, mintRt, cfg);

    RT_AMOUNT = new BN(1).mul(new BN(10).pow(new BN(RT_DECIMALS)));
    buyer = await setupUser(provider, mintRt, addrs.ctMintPda, {
      rtAmount: Number(RT_AMOUNT),
    });

    somebodyElse = await setupUser(provider, mintRt, addrs.ctMintPda, {
      rtAmount: Number(RT_AMOUNT),
    });
  });

  describe("Referred buys...", () => {

    it("...fail when being referred by an account with insufficient balance", async () => {
      try {
        await program.methods
          .buy(RT_AMOUNT)
          .accountsStrict(buyAccounts(addrs, mintRt, somebodyElse, buyer))
          .signers([somebodyElse.keypair])
          .rpc();
        expect.fail("should have failed");
      } catch (e) {
        expect(e.error.errorCode).to.deep.eq({
          code: "InvalidReferral",
          number: 6005,
        });
      }
    });

    it("...succeed when being referred by an account with sufficient balance", async () => {
      await program.methods
        .buy(RT_AMOUNT)
        .accountsStrict(buyAccounts(addrs, mintRt, buyer))
        .signers([buyer.keypair])
        .rpc();

      await program.methods
        .buy(RT_AMOUNT)
        .accountsStrict(buyAccounts(addrs, mintRt, somebodyElse, buyer))
        .signers([somebodyElse.keypair])
        .rpc();
    });
  });
});
