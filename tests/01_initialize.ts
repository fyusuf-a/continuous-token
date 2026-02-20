import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ContinuousToken } from "../target/types/continuous_token";
import { createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import assert from "node:assert/strict";
import { expect } from "chai";

const RT_DECIMALS = 6;

const airdrop = async (provider: anchor.AnchorProvider, publicKey: anchor.web3.PublicKey) => {
  const signature = await provider.connection.requestAirdrop(publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
  const latestBlockHash = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({
    signature,
    ...latestBlockHash,
  }, "confirmed");
}

const airdropRT = async (provider: anchor.AnchorProvider, mintRT: anchor.web3.PublicKey, destination: anchor.web3.PublicKey) => {
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
    1000000,
  );
}

const randomBN = (max: number) => {
  return new anchor.BN(Math.floor(Math.random() * max));
}

describe("Program initialization", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.continuousToken as Program<ContinuousToken>;

  const initializer = provider.wallet.publicKey;
  let mintRt: anchor.web3.PublicKey;
  let vaultRt: anchor.web3.PublicKey;
  const seed = randomBN(1000);
  const firstPrice = new anchor.BN(0.01 * 10 ** RT_DECIMALS); // 0.01 RT
  const reserveRatioBps = 9_000; // 90%
  const baseFeeBps = 100; // 1%
  const discountBps = 50; // .5%
  const rtTokenName = "RT Token";
  const rtTokenSymbol = "RT";
  const rtTokenUri = "https://example.com/rt-token-metadata.json";

  const [configPda, configBump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config"), seed.toArrayLike(Buffer, "le", 8)],
    program.programId,
  );
  const [ctMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("ct"), seed.toArrayLike(Buffer, "le", 8)],
    program.programId,
  );

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

    vaultRt = getAssociatedTokenAddressSync(mintRt, configPda, true);
  });

  it("Program fails to initialize if discount > fee", async () => {
    let baseFeeBps = 100;
    let discountBps = 150;

    await assert.rejects(async () => {
      await program.methods.initialize(
        seed,
        firstPrice,
        reserveRatioBps,
        baseFeeBps,
        discountBps,
        rtTokenName,
        rtTokenSymbol,
        rtTokenUri,
      ).accountsStrict({
        initializer,
        config: configPda,
        mintCt: ctMintPda,
        mintRt,
        vaultRt,
        tokenProgramRt: anchor.utils.token.TOKEN_PROGRAM_ID,
        tokenProgramCt: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      }).rpc();
    },
      () => true,
      "Config should fail"
    );
  });

  it("Program successfully initializes", async () => {
    await program.methods.initialize(
      seed,
      firstPrice,
      reserveRatioBps,
      baseFeeBps,
      discountBps,
      rtTokenName,
      rtTokenSymbol,
      rtTokenUri,
    ).accountsStrict({
      initializer,
      config: configPda,
      mintCt: ctMintPda,
      mintRt,
      vaultRt,
      tokenProgramRt: anchor.utils.token.TOKEN_PROGRAM_ID,
      tokenProgramCt: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();
  });

  it("After intialization, config account is correctly initialized", async () => {
    let config = await program.account.config.fetch(configPda);
    expect(config.seed.toString()).to.equal(seed.toString());
    expect(config.firstPrice.toString()).to.equal(firstPrice.toString());
    expect(config.discountBps.toString()).to.equal(discountBps.toString());
    expect(config.baseFeeBps.toString()).to.equal(baseFeeBps.toString());
    expect(config.discountBps.toString()).to.equal(discountBps.toString());
    expect(config.bump).to.equal(configBump);
  });

  it("After initialization, vault RT account is correctly initialized", async () => {
    const vaultAccount = await provider.connection.getAccountInfo(vaultRt);
    expect(vaultAccount).to.not.be.null;
    expect(vaultAccount?.owner.toString()).to.equal(anchor.utils.token.TOKEN_PROGRAM_ID.toString());
    const vaultBalance = await provider.connection.getTokenAccountBalance(vaultRt);
    expect(vaultBalance.value.uiAmount).to.equal(0);
  });

  it("After initialization, continuous token has the correct metadata", async () => {
    const mintAccount = await provider.connection.getAccountInfo(ctMintPda);
    expect(mintAccount).to.not.be.null;
    expect(mintAccount?.owner.toString()).to.equal(TOKEN_2022_PROGRAM_ID.toString());
    const metadata = await getTokenMetadata(provider.connection, ctMintPda);
    expect(metadata.updateAuthority.toString()).to.equal(configPda.toString());
    expect(metadata.name).to.equal(rtTokenName);
    expect(metadata.symbol).to.equal(rtTokenSymbol);
    expect(metadata.uri).to.equal(rtTokenUri);
  });


});
