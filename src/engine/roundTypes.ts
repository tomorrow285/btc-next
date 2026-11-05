/** runRound / placeBet / runner 之间共享的上下文类型。 */
import type { Wallet } from "../binance/accountApi.js";
import type { PredictionWindow } from "../market/window.js";
import type { Strategy } from "../strategy/types.js";
import type { FundingAccount } from "./funding.js";
import type { TradeRecord } from "./tradeLog.js";

export interface EngineContext {
  wallet: Wallet;
  funding: FundingAccount;
  strategy: Strategy;
}

export interface RoundRun {
  window: PredictionWindow;
  /** 已下单且等待结算的记录；没有下注为 null。 */
  openRecord: TradeRecord | null;
}
