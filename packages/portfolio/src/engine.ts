import {
  round2,
  type Bar, type Book, type EquitySnapshot, type Position, type Proposal,
} from "@quantrade/core";
import { addSessions } from "./calendar.js";
import { computeCosts } from "./costs.js";
import { resolveEntry, resolveExit, applySlippage } from "./fills.js";
import { sizePosition, validateProposal } from "./sizing.js";

export interface PendingEntry {
  proposal: Proposal;
  sector: string;
}

export interface SettleInput {
  book: Book;
  date: string;
  openPositions: Position[];
  pendingEntries: PendingEntry[];
  /** Bars for `date`, keyed by symbol. A missing symbol is a rejection, not a guess. */
  bars: Record<string, Bar>;
  sectors: Record<string, string>;
}

export interface SettleResult {
  book: Book;
  opened: Position[];
  closed: Position[];
  stillOpen: Position[];
  rejected: Array<{ proposalId: string; reason: string }>;
  snapshot: EquitySnapshot;
}

/** Mark-to-market value of a position at a given price. */
function markValue(pos: Position, price: number): number {
  const base = pos.qty * pos.entryPrice;
  const move = (price - pos.entryPrice) * pos.qty;
  return round2(pos.direction === "long" ? base + move : base - move);
}

export function settle(input: SettleInput): SettleResult {
  const { book, date, bars, sectors } = input;
  let cash = book.cash;

  const closed: Position[] = [];
  const stillOpen: Position[] = [];
  const opened: Position[] = [];
  const rejected: Array<{ proposalId: string; reason: string }> = [];

  // --- 1. Resolve exits on existing positions, before any new entry. ---
  for (const pos of input.openPositions) {
    const bar = bars[pos.symbol];
    if (!bar) {
      // No data for today: carry the position rather than inventing a price.
      stillOpen.push(pos);
      continue;
    }

    let exit = resolveExit(bar, pos);

    if (!exit) {
      const dueDate = addSessions(book.market, pos.entryDate, pos.maxHoldSessions);
      if (date >= dueDate) {
        const side = pos.direction === "long" ? "sell" : "buy";
        exit = { price: applySlippage(bar.open, side), reason: "max_hold" };
      }
    }

    if (!exit) {
      stillOpen.push(pos);
      continue;
    }

    const exitCosts = computeCosts(
      book.market,
      pos.direction === "long" ? "sell" : "buy",
      pos.qty,
      exit.price,
    ).total;

    const grossPnl = round2(
      pos.direction === "long"
        ? (exit.price - pos.entryPrice) * pos.qty
        : (pos.entryPrice - exit.price) * pos.qty,
    );
    const netPnl = round2(grossPnl - pos.entryCosts - exitCosts);

    if (!pos.isShadow) {
      cash = round2(cash + pos.qty * exit.price - exitCosts);
    }

    closed.push({
      ...pos,
      status: "closed",
      exitPrice: exit.price,
      exitDate: date,
      exitReason: exit.reason,
      exitCosts,
      grossPnl,
      netPnl,
    });
  }

  // --- 2. Open approved proposals at today's open. ---
  const equityForSizing = book.startingCapital;
  for (const { proposal, sector } of input.pendingEntries) {
    const bar = bars[proposal.symbol];
    if (!bar) {
      rejected.push({ proposalId: proposal.id, reason: `No bar for ${proposal.symbol} on ${date}` });
      continue;
    }

    const entryPrice = resolveEntry(bar, proposal.direction);
    const verdict = validateProposal({
      market: book.market,
      symbol: proposal.symbol,
      direction: proposal.direction,
      entryPrice,
      stopLoss: proposal.stopLoss,
      target: proposal.target,
      sector,
      equity: equityForSizing,
      cash,
      openPositions: stillOpen,
    });

    if (!verdict.ok) {
      rejected.push({ proposalId: proposal.id, reason: verdict.reason });
      continue;
    }

    const { qty } = sizePosition({
      equity: equityForSizing,
      entryPrice,
      stopLoss: proposal.stopLoss,
      direction: proposal.direction,
    });

    const entryCosts = computeCosts(
      book.market,
      proposal.direction === "long" ? "buy" : "sell",
      qty,
      entryPrice,
    ).total;

    const position: Position = {
      id: `${proposal.id}-pos`,
      proposalId: proposal.id,
      bookId: book.id,
      symbol: proposal.symbol,
      sector: sectors[proposal.symbol] ?? sector,
      direction: proposal.direction,
      qty,
      entryPrice,
      entryDate: date,
      stopLoss: proposal.stopLoss,
      target: proposal.target,
      maxHoldSessions: proposal.maxHoldSessions,
      status: "open",
      isShadow: proposal.status === "rejected" || proposal.status === "expired",
      entryCosts,
    };

    if (!position.isShadow) {
      cash = round2(cash - qty * entryPrice - entryCosts);
    }

    opened.push(position);
    stillOpen.push(position);
  }

  // --- 3. Mark the book to today's closes. ---
  const deployed = round2(
    stillOpen
      .filter((p) => !p.isShadow)
      .reduce((sum, p) => {
        const bar = bars[p.symbol];
        return sum + markValue(p, bar ? bar.close : p.entryPrice);
      }, 0),
  );

  const snapshot: EquitySnapshot = {
    bookId: book.id,
    date,
    cash: round2(cash),
    deployed,
    equity: round2(cash + deployed),
  };

  return {
    book: { ...book, cash: round2(cash) },
    opened,
    closed,
    stillOpen,
    rejected,
    snapshot,
  };
}
