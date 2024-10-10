import {
  ActionPostResponse,
  ACTIONS_CORS_HEADERS,
  ActionGetResponse,
} from "@solana/actions";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  PublicKeyInitData,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

export const GET = async (req: Request) => {
  const payload: ActionGetResponse = {
    title: "Gasless Swap from any SPL token!",
    icon: "https://utfs.io/f/a12e4c3c-5f83-45a9-a35f-04113a236688-i0tr7r.jpg",
    description: "Gaslessly swap from any SPL token into exactly 0.015 SOL",
    label: "Swap USDC to 0.015 SOL",
    links: {
      actions: [
        {
          label: "Swap",
          href: "/api/actions/swap?symbol={symbol}",
          parameters: [
            {
              name: "symbol",
              label: "Enter a token symbol eg. JUP",
            },
          ],
        },
      ],
    },
  };

  return new Response(JSON.stringify(payload), {
    headers: {
      ...ACTIONS_CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
};

// DO NOT FORGET TO INCLUDE THE `OPTIONS` HTTP METHOD
// THIS WILL ENSURE CORS WORKS FOR BLINKS
export const OPTIONS = GET;

export const POST = async (req: Request) => {
  try {
    const url = new URL(req.url);
    const symbol =
      url.searchParams.get("symbol")?.trim().toLowerCase() ?? undefined;

    const body: any = await req.json();

    // Validate account field
    let account: PublicKey;
    try {
      account = new PublicKey(body.account);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Invalid "account" provided' }),
        {
          status: 400,
          headers: ACTIONS_CORS_HEADERS,
        }
      );
    }

    console.log("symbol is", symbol);

    let mintAddress: string | undefined;
    if (symbol) {
      // use JUP strict list of tokens
      const strictUrl = "https://token.jup.ag/strict";

      const response = await fetch(strictUrl);
      const tokenList = await response.json();

      // find the mint of with the desired symbol
      const token = tokenList.find((token: any) => {
        const normalizedTokenSymbol = token.symbol.trim().toLowerCase();
        console.log(`Comparing ${normalizedTokenSymbol} with ${symbol}`);
        return normalizedTokenSymbol === symbol;
      });

      if (token) {
        mintAddress = token.mintAddress || token.address;
      } else {
        return new Response(
          JSON.stringify({
            error: `Token with symbol ${symbol.toUpperCase()} not found.`,
          }),
          {
            status: 404,
            headers: ACTIONS_CORS_HEADERS,
          }
        );
      }
    }

    // use your RPC
    const connection = new Connection("https://api.mainnet-beta.solana.com");

    const feeAccount = new PublicKey(
      "9bm4Zd7tjptorkhs71vP5gL2mjZKbUjNqxL36swznuHr"
    );

    const [{ blockhash, lastValidBlockHeight }] = await Promise.all([
      connection.getLatestBlockhash(),
    ]);

    const quoteResponse = await (
      await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}\
&outputMint=So11111111111111111111111111111111111111112\
&amount=15000000\
&autoSlippage=true\
&swapMode=ExactOut\
&maxAutoSlippageBps=300`)
    ).json();

    const instructions = await (
      await fetch("https://quote-api.jup.ag/v6/swap-instructions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // quoteResponse from /quote api
          quoteResponse,
          userPublicKey: account.toBase58(),
          // feeAccount: feeAccount.toBase58(),
          wrapAndUnwrapSol: true,
          useTokenLedger: false,
          dynamicComputeUnitLimit: true, // allow dynamic compute limit instead of max 1,400,000
          prioritizationFeeLamports: "auto", // or custom lamports: 1000
        }),
      })
    ).json();

    if (instructions.error) {
      throw new Error("Failed to get swap instructions: " + instructions.error);
    }

    const {
      tokenLedgerInstruction, // If you are using `useTokenLedger = true`.
      computeBudgetInstructions, // The necessary instructions to setup the compute budget.
      setupInstructions, // Setup missing ATA for the users.
      swapInstruction: swapInstructionPayload, // The actual swap instruction.
      cleanupInstruction, // Unwrap the SOL if `wrapAndUnwrapSol = true`.
      addressLookupTableAddresses, // The lookup table addresses that you can use if you are using versioned transaction.
    } = instructions;

    const deserializeInstruction = (instruction: {
      programId: PublicKeyInitData;
      accounts: any[];
      data:
        | WithImplicitCoercion<string>
        | { [Symbol.toPrimitive](hint: "string"): string };
    }) => {
      return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: instruction.accounts.map((key) => ({
          pubkey: new PublicKey(key.pubkey),
          isSigner: key.isSigner,
          isWritable: key.isWritable,
        })),
        data: Buffer.from(instruction.data, "base64"),
      });
    };

    const getAddressLookupTableAccounts = async (
      keys: string[]
    ): Promise<AddressLookupTableAccount[]> => {
      const addressLookupTableAccountInfos =
        await connection.getMultipleAccountsInfo(
          keys.map((key) => new PublicKey(key))
        );

      return addressLookupTableAccountInfos.reduce(
        (acc, accountInfo, index) => {
          const addressLookupTableAddress = keys[index];
          if (accountInfo) {
            const addressLookupTableAccount = new AddressLookupTableAccount({
              key: new PublicKey(addressLookupTableAddress),
              state: AddressLookupTableAccount.deserialize(accountInfo.data),
            });
            acc.push(addressLookupTableAccount);
          }

          return acc;
        },
        new Array<AddressLookupTableAccount>()
      );
    };

    const addressLookupTableAccounts: AddressLookupTableAccount[] = [];

    addressLookupTableAccounts.push(
      ...(await getAddressLookupTableAccounts(addressLookupTableAddresses))
    );

    // fee paying private key
    const shopPrivateKey = process.env.PAYER_PRIVATE_KEY as string;
    // if (!shopPrivateKey) {
    //   res.status(500).json({ error: "Shop private key not available" })
    // }
    const shopKeypair = Keypair.fromSecretKey(bs58.decode(shopPrivateKey));
    const shopPublicKey = shopKeypair.publicKey;

    // return back the fee
    const transferFeeInstruction = SystemProgram.transfer({
      fromPubkey: account,
      lamports: 2200000,
      toPubkey: feeAccount,
    });

    const wrappedSolMint = new PublicKey(
      "So11111111111111111111111111111111111111112"
    );

    const toTokenAccount = getAssociatedTokenAddressSync(
      wrappedSolMint,
      account
    );
    const createAccountIx = createAssociatedTokenAccountInstruction(
      shopPublicKey,
      toTokenAccount,
      account,
      wrappedSolMint
    );

    // set fee payer to sponsor
    const messageV0 = new TransactionMessage({
      payerKey: shopPublicKey,
      recentBlockhash: blockhash,
      instructions: [
        createAccountIx,
        ...computeBudgetInstructions.map(deserializeInstruction),
        ...setupInstructions.map(deserializeInstruction),
        deserializeInstruction(swapInstructionPayload),
        deserializeInstruction(cleanupInstruction),
        transferFeeInstruction,
      ],
    }).compileToV0Message(addressLookupTableAccounts);

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([shopKeypair]);

    const serializedTx = transaction.serialize();

    const payload: ActionPostResponse = {
      transaction: Buffer.from(serializedTx).toString("base64"),
      message: "Gasless Swap powered by Monstrè",
    };
    return new Response(JSON.stringify(payload), {
      headers: ACTIONS_CORS_HEADERS,
    });
  } catch (err) {
    console.log(err);
    let message = "An unknown error occurred";
    if (typeof err === "string") message = err;
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: ACTIONS_CORS_HEADERS,
    });
  }
};
