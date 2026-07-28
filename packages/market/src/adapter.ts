import type { Bar } from "@quantrade/core";

export interface NewsItem {
  title: string;
  publisher: string;
  publishedAt: string; // ISO 8601
  url: string;
}

export interface MarketAdapter {
  readonly name: string;
  /** Inclusive date range, both YYYY-MM-DD, ascending result order. */
  dailyBars(symbol: string, from: string, to: string): Promise<Bar[]>;
  news(symbol: string, since: string): Promise<NewsItem[]>;
}
