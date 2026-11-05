/** 预测盘账户只读接口（签名）：钱包、余额、配额、持仓、已结算记录。 */
import { signedRequest } from "./http.js";

const PREDICTION_PATH = "/sapi/v1/w3w/wallet/prediction";

export interface Wallet {
  walletAddress: string;
  walletId: string;
}

export async function listWallets(): Promise<Wallet[]> {
  const data = await signedRequest<{
    wallets?: Array<{ walletAddress?: string; walletId?: string }>;
  }>("GET", `${PREDICTION_PATH}/wallet/list`);

  return (data.wallets ?? []).map((wallet) => ({
    walletAddress: wallet.walletAddress ?? "",
    walletId: wallet.walletId ?? "",
  }));
}

export interface PaymentOption {
  accountType: string;
  availableBalance: string;
  enabled: boolean;
}

/** 各支付账户的可用余额（CeDeFi / SPOT / FUNDING）。 */
export async function paymentOptions(): Promise<PaymentOption[]> {
  const data = await signedRequest<{
    items?: Array<{ accountType?: string; availableBalanceDisplay?: string; enabled?: boolean }>;
  }>("GET", `${PREDICTION_PATH}/balance/payment-options`);

  return (data.items ?? []).map((item) => ({
    accountType: item.accountType ?? "",
    availableBalance: item.availableBalanceDisplay ?? "0",
    enabled: item.enabled ?? false,
  }));
}

export interface Quota {
  dailyLimit: string;
  remainingDailyLimit: string;
}

export async function quota(): Promise<Quota> {
  const data = await signedRequest<{ dailyLimit?: string; remainingDailyLimit?: string }>(
    "GET",
    `${PREDICTION_PATH}/quota/limit/status`,
  );
  return {
    dailyLimit: data.dailyLimit ?? "0",
    remainingDailyLimit: data.remainingDailyLimit ?? "0",
  };
}

/** 一笔已结算的持仓。金额字段都是 USDT 字符串。 */
export interface SettledPosition {
  marketId: number;
  tokenId: string;
  positionId: number;
  marketTitle: string;
  outcomeName: string;
  shares: string;
  avgPrice: string;
  totalCost: string;
  value: string;
  isWinner: boolean;
  /** 已实现盈亏 —— 链上对账时喂给账本的那个数。 */
  realizedPnl: string;
  claimAmount: string;
  settledDate: number;
}

interface RawSettledPosition {
  marketId?: number;
  tokenId?: string;
  positionId?: number;
  marketTitle?: string;
  outcomeName?: string;
  shares?: string;
  avgPrice?: string;
  totalCost?: string;
  value?: string;
  isWinner?: boolean;
  realizedPnl?: string;
  claimAmount?: string;
  settledDate?: number;
}

export async function settledPositions(
  walletAddress: string,
  limit = 30,
): Promise<SettledPosition[]> {
  const data = await signedRequest<{ positions?: RawSettledPosition[] }>(
    "GET",
    `${PREDICTION_PATH}/position/settled-history`,
    { walletAddress, limit },
  );

  return (data.positions ?? []).map((position) => ({
    marketId: Number(position.marketId ?? 0),
    tokenId: position.tokenId ?? "",
    positionId: Number(position.positionId ?? 0),
    marketTitle: position.marketTitle ?? "",
    outcomeName: position.outcomeName ?? "",
    shares: position.shares ?? "0",
    avgPrice: position.avgPrice ?? "0",
    totalCost: position.totalCost ?? "0",
    value: position.value ?? "0",
    isWinner: position.isWinner ?? false,
    realizedPnl: position.realizedPnl ?? "0",
    claimAmount: position.claimAmount ?? "0",
    settledDate: Number(position.settledDate ?? 0),
  }));
}

export interface PositionSummary {
  walletBalance: string;
  positionValue: string;
  totalValue: string;
  claimable: string;
  todayRealizedPnl: string;
  ongoingCount: number;
  endedCount: number;
  pendingClaimCount: number;
}

export async function positionSummary(walletAddress: string): Promise<PositionSummary> {
  const data = await signedRequest<{
    summary?: {
      walletBalance?: string;
      positionValue?: string;
      totalValue?: string;
      totalClaimableAmount?: string;
      todayRealizedPnl?: string;
    };
    counts?: {
      ongoingCount?: number;
      endedCount?: number;
      pendingClaimCount?: number;
    };
  }>("GET", `${PREDICTION_PATH}/position/list`, { walletAddress });

  const summary = data.summary ?? {};
  const counts = data.counts ?? {};
  return {
    walletBalance: summary.walletBalance ?? "0",
    positionValue: summary.positionValue ?? "0",
    totalValue: summary.totalValue ?? "0",
    claimable: summary.totalClaimableAmount ?? "0",
    todayRealizedPnl: summary.todayRealizedPnl ?? "0",
    ongoingCount: Number(counts.ongoingCount ?? 0),
    endedCount: Number(counts.endedCount ?? 0),
    pendingClaimCount: Number(counts.pendingClaimCount ?? 0),
  };
}
