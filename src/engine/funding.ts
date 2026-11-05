/**
 * 支付账户选择：启动时调用一次 balance/payment-options，
 * 选已启用账户里可用余额最多的那个，之后所有订单都复用它。
 */
import type { AccountType, FundingSource } from "../binance/tradeApi.js";
import { paymentOptions } from "../binance/accountApi.js";
import { dec } from "../util/decimal.js";

interface FundingRoute {
  fundingSource: FundingSource;
  accountType: AccountType;
  label: string;
}

const FUNDING_ROUTES: Record<string, FundingRoute> = {
  CeDeFi: { fundingSource: "MPC", accountType: "SPOT", label: "预测钱包 CeDeFi" },
  SPOT: { fundingSource: "CEX", accountType: "SPOT", label: "现货 SPOT" },
  FUNDING: { fundingSource: "CEX", accountType: "FUNDING", label: "资金账户 FUNDING" },
};

export interface FundingAccount extends FundingRoute {
  availableUsdt: string;
}

/** 选出余额最多的已启用支付账户；一个都没有时抛错。 */
export async function selectFundingAccount(): Promise<FundingAccount> {
  const options = await paymentOptions();
  let best: FundingAccount | null = null;

  for (const option of options) {
    const route = FUNDING_ROUTES[option.accountType];
    if (!route || !option.enabled) continue;

    const candidate: FundingAccount = {
      ...route,
      availableUsdt: option.availableBalance,
    };
    if (!best || dec(candidate.availableUsdt).gt(best.availableUsdt)) {
      best = candidate;
    }
  }

  if (!best) {
    const detail = options
      .map((option) => `${option.accountType}=${option.availableBalance}`)
      .join(" / ");
    throw new Error(`没有可用的支付账户（${detail || "balance/payment-options 返回空"}）`);
  }

  return best;
}
