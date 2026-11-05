/**
 * 补结算：只做链上对账（不做盘面推导）。
 *
 * 用 `position/settled-history` 的 realizedPnl 给还没入账的注收口。
 * 每次调用都带时间预算：预算用尽只是「这次没空做」，留到下一次 catchUpOnce。
 */
import type { SettledPosition, Wallet } from "../../binance/accountApi.js";
import { settledPositions } from "../../binance/accountApi.js";
import {
  UNFILLED_STATUS,
  findOrderById,
} from "../../binance/tradeApi.js";
import { config } from "../../config/env.js";
import { tradeIdOf } from "../../market/window.js";
import { isBudgetError, sleep, withBudget } from "../../util/async.js";
import { dec } from "../../util/decimal.js";
import { errorText, logEvent } from "../../util/log.js";
import { openTrades, updateTrade, type TradeRecord } from "../tradeLog.js";
import { bookSettlement, closeAsVoid, markError, matchesOpenRecord } from "./ledger.js";

type FillProbe = "FILLED" | "VOID" | "UNKNOWN";

/** 只认订单历史里的证据，判断这单到底有没有成交。 */
async function probeFillState(wallet: Wallet, record: TradeRecord): Promise<FillProbe> {
  if (record.filledShares !== null && dec(record.filledShares).gt(0)) return "FILLED";
  if (!record.orderId) return "UNKNOWN";

  try {
    const order = await findOrderById(wallet.walletAddress, record.orderId);
    if (!order) return "UNKNOWN";
    if (order.status === "FILLED") {
      return dec(order.filledShares).gt(0) ? "FILLED" : "VOID";
    }
    if (UNFILLED_STATUS.has(order.status)) return "VOID";
    return "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

/**
 * 每窗一次补结算机会：把已收盘窗口里未结的注用链上结算记录收口。
 * 预算用尽只代表「这次没空做」，留到下一次。
 */
export async function reconcilePending(wallet: Wallet, deadlineMs: number): Promise<void> {
  const rows = openTrades().filter((record) => record.windowEnd <= Date.now());
  if (rows.length === 0) return;

  for (const row of rows) {
    if (Date.now() >= deadlineMs) {
      logEvent("catchup_budget_exhausted", { remaining: rows.length }, "warn");
      return;
    }

    const tries = (row.catchUpTries ?? 0) + 1;

    let fill: FillProbe;
    try {
      fill = await withBudget(
        probeFillState(wallet, row),
        deadlineMs - Date.now(),
        "查订单成交状态",
      );
    } catch (error) {
      if (isBudgetError(error)) {
        logEvent("catchup_budget_exhausted", { message: errorText(error) }, "warn");
        return;
      }
      fill = "UNKNOWN";
    }

    if (fill === "VOID") {
      closeAsVoid(row, tries);
      continue;
    }

    if (tries > config.timing.catchUpMaxTries) {
      if (
        fill !== "FILLED" &&
        !(row.filledShares !== null && dec(row.filledShares).gt(0))
      ) {
        closeAsVoid(row, tries, `补齐 ${config.timing.catchUpMaxTries} 次仍未成交`);
        continue;
      }
      markError(
        row,
        tries,
        `${row.error ? `${row.error}；` : ""}补齐尝试 ${config.timing.catchUpMaxTries} 次仍无结论`,
      );
      continue;
    }

    logEvent("catchup_attempt", {
      tradeId: tradeIdOf(row),
      marketId: row.marketId,
      status: row.status,
      tries,
    });

    try {
      const budget = Math.min(
        config.timing.chainQueryTimeoutS * 1000,
        deadlineMs - Date.now(),
      );
      const settlement = await withBudget(
        waitSettlement(wallet, row.marketId, budget),
        budget,
        "等链上结算记录",
      );

      bookSettlement(row, {
        pnl: settlement.realizedPnl,
        outcome: null,
        payout: settleValueOf(settlement),
        source: "chain",
        late: true,
        filledShares: settlement.shares,
        filledUsdt: settlement.totalCost,
        resultText: `${settlement.outcomeName} ${settlement.isWinner ? "赢" : "输"}（链上对账）`,
      });
    } catch (error) {
      if (isBudgetError(error)) {
        logEvent("catchup_budget_exhausted", { message: errorText(error) }, "warn");
        return;
      }
      updateTrade(matchesOpenRecord(row), { catchUpTries: tries });
      logEvent(
        "catchup_incomplete",
        { tradeId: tradeIdOf(row), marketId: row.marketId, message: errorText(error) },
        "warn",
      );
    }
  }
}

async function waitSettlement(
  wallet: Wallet,
  marketId: number,
  timeoutMs: number,
): Promise<SettledPosition> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const positions = await settledPositions(wallet.walletAddress, 30);
      const hit = positions.find((position) => position.marketId === marketId);
      if (hit) return hit;
    } catch (error) {
      lastError = error;
    }
    await sleep(5_000);
  }

  throw new Error(
    `等 ${Math.round(timeoutMs / 1000)}s 仍查不到结算记录（marketId=${marketId}）` +
      `${lastError ? `；最后一次查询报错：${errorText(lastError)}` : ""}`,
  );
}

function settleValueOf(position: SettledPosition): string {
  const shares = dec(position.shares);
  const cost = dec(position.totalCost);
  if (!shares.gt(0)) return "0";
  return dec(position.realizedPnl).plus(cost).div(shares).toFixed();
}

/** 主循环与启动阶段共用的补结算入口。 */
export async function catchUpOnce(wallet: Wallet): Promise<void> {
  try {
    await reconcilePending(
      wallet,
      Date.now() + config.timing.reconcileBudgetS * 1000,
    );
  } catch (error) {
    logEvent("error", { scope: "catchup", message: errorText(error) }, "error");
  }
}
