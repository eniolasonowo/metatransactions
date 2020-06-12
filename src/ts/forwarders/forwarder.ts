import { ChainID } from "../..";
import { ReplayProtectionAuthority } from "../replayProtection/replayProtectionAuthority";
import { Signer } from "ethers";
import {
  defaultAbiCoder,
  BigNumberish,
  arrayify,
  keccak256,
} from "ethers/utils";
import { DELEGATE_DEPLOYER_ADDRESS } from "../../deployment/addresses";
import { DelegateDeployerFactory } from "../../typedContracts/DelegateDeployerFactory";

export enum CallType {
  CALL = 0,
  DELEGATE = 1,
  BATCH = 2,
}

export interface MinimalTx {
  to: string;
  data: string;
}

export interface ForwardParams {
  to: string;
  signer: string;
  target: string;
  value: string;
  data: string;
  callType: CallType;
  replayProtection: string;
  replayProtectionAuthority: string;
  chainId: number;
  signature: string;
}

type DirectCallData = {
  to: string;
  data?: string;
  value?: BigNumberish;
};

type DeployCallData = {
  data: string;
  value?: BigNumberish;
  salt: string;
};

type CallData = DirectCallData | DeployCallData;

// https://stackoverflow.com/questions/42123407/does-typescript-support-mutually-exclusive-types
type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };
export type XOR<T, U> = T | U extends object
  ? (Without<T, U> & U) | (Without<U, T> & T)
  : T | U;

/**
 * Provides common functionality for the RelayHub and the ProxyAccounts.
 * Possible to extend it with additional functionality if another
 * msg.sender solution emerges.
 */
export abstract class Forwarder<
  TCallData extends DirectCallData,
  TDeployCallData extends DeployCallData,
  TBatchCallData extends CallData,
  TBatchDeployCallData extends CallData
> {
  constructor(
    protected readonly chainID: ChainID,
    public readonly signer: Signer,
    /**
     * The address of this forwarder contract
     */
    public readonly address: string,
    protected readonly replayProtectionAuthority: ReplayProtectionAuthority
  ) {}

  protected abstract encodeBatchCallData(data: TBatchCallData[]): string;
  protected abstract async encodeBatchTx(
    data: TBatchCallData[],
    replayProtection: string,
    replayProtectionAuthority: string,
    signature: string
  ): Promise<string>;
  protected abstract encodeCallData(data: TCallData): string;
  protected abstract async encodeTx(
    data: TCallData,
    replayProtection: string,
    replayProtectionAuthority: string,
    signature: string
  ): Promise<string>;
  protected abstract toBatchCallData(
    initCode: string,
    extraData: string,
    value?: BigNumberish,
    revertOnFail?: boolean
  ): TBatchCallData;
  protected abstract toCallData(
    initCode: string,
    extraData: string,
    value?: BigNumberish
  ): TCallData;
  public abstract decodeTx(
    data: string
  ): {
    _metaTx: Required<TCallData>;
    _replayProtection: string;
    _replayProtectionAuthority: string;
    _signature: string;
  };
  public abstract decodeBatchTx(
    data: string
  ): {
    _metaTxList: Required<TBatchCallData[]>;
    _replayProtection: string;
    _replayProtectionAuthority: string;
    _signature: string;
  };

  private isDeployTx(tx: CallData): tx is DeployCallData {
    return !!(tx as DeployCallData).salt;
  }

  public async signMetaTransaction(
    tx:
      | XOR<TCallData, TDeployCallData>
      | XOR<TBatchCallData, TBatchDeployCallData>[]
  ): Promise<MinimalTx> {
    if (Array.isArray(tx)) {
      const encodedTransactions = tx.map((t) =>
        this.isDeployTx(t)
          ? this.toBatchCallData(t.data, t.salt, t.value || "0x")
          : (t as TBatchCallData)
      );

      return await this.signAndEncodeBatchMetaTransaction(encodedTransactions);
    } else {
      const txOrDeploy = this.isDeployTx(tx)
        ? this.toCallData(tx.data, tx.salt, tx.value || "0x")
        : (tx as TCallData);

      return await this.signAndEncodeMetaTransaction(txOrDeploy);
    }
  }

  protected encodeForDeploy(
    initCode: string,
    extraData: string,
    value: BigNumberish
  ) {
    const deployer = new DelegateDeployerFactory(this.signer).attach(
      DELEGATE_DEPLOYER_ADDRESS
    );

    const data = deployer.interface.functions.deploy.encode([
      initCode,
      value,
      keccak256(extraData),
    ]);

    return {
      to: deployer.address,
      data: data,
    };
  }

  public async encodeAndSignParams(
    callData: string,
    replayProtection: string,
    replayProtectionAuthority: string
  ) {
    const encodedMetaTx = defaultAbiCoder.encode(
      ["bytes", "bytes", "address", "address", "uint"],
      [
        callData,
        replayProtection,
        replayProtectionAuthority,
        this.address,
        this.chainID,
      ]
    );

    const signature = await this.signer.signMessage(
      arrayify(keccak256(encodedMetaTx))
    );

    return {
      encodedMetaTx,
      signature,
    };
  }

  /**
   * Takes care of replay protection and signs a meta-transaction.
   * @param data ProxyAccountCallData or RelayCallData
   */
  protected async signAndEncodeMetaTransaction(
    data: TCallData
  ): Promise<MinimalTx> {
    const encodedCallData = this.encodeCallData(data);

    const replayProtection = await this.replayProtectionAuthority.getEncodedReplayProtection();

    const { signature } = await this.encodeAndSignParams(
      encodedCallData,
      replayProtection,
      this.replayProtectionAuthority.address
    );

    const encodedTx = await this.encodeTx(
      data,
      replayProtection,
      this.replayProtectionAuthority.address,
      signature
    );
    return {
      to: this.address,
      data: encodedTx
    };
  }

  /**
   * Batches a list of transactions into a single meta-transaction.
   * It supports both meta-transactions & meta-deployment.
   * @param dataList List of meta-transactions to batch
   */
  protected async signAndEncodeBatchMetaTransaction(
    dataList: TBatchCallData[]
  ): Promise<MinimalTx> {
    const encodedCallData = this.encodeBatchCallData(dataList);
    // TODO:51: what about supplying value? shouldne that be returnedd?

    const replayProtection = await this.replayProtectionAuthority.getEncodedReplayProtection();

    const { signature } = await this.encodeAndSignParams(
      encodedCallData,
      replayProtection,
      this.replayProtectionAuthority.address
    );

    const encodedBatch = await this.encodeBatchTx(
      dataList,
      replayProtection,
      this.replayProtectionAuthority.address,
      signature
    );

    return {
      to: this.address,
      data: encodedBatch,
    };
  }
}
