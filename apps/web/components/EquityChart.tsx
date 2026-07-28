"use client";

import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { CurvePoint } from "@/lib/stats";

export function EquityChart({ data, label }: { data: CurvePoint[]; label: string }) {
  if (data.length === 0) {
    return (
      <div className="h-64 grid place-items-center rounded-lg border border-[--color-border] bg-[--color-surface]">
        <p className="text-sm text-[--color-muted]">No equity history yet.</p>
      </div>
    );
  }

  return (
    <div className="h-72 rounded-lg border border-[--color-border] bg-[--color-surface] p-3">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="oklch(0.32 0.012 70)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: "oklch(0.68 0.012 80)" }}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "oklch(0.68 0.012 80)" }}
            tickLine={false}
            axisLine={false}
            width={64}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => Intl.NumberFormat("en", { notation: "compact" }).format(v)}
          />
          <Tooltip
            contentStyle={{
              background: "oklch(0.21 0.010 70)",
              border: "1px solid oklch(0.32 0.012 70)",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(v: number) => Intl.NumberFormat("en").format(Math.round(v))}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            type="monotone"
            dataKey="agent"
            name={`${label} agent`}
            stroke="#d79a3d"
            strokeWidth={2}
            dot={false}
          />
          {/* Equal visual weight, deliberately. The benchmark is what the agent
              is judged against, not a faint reference line. */}
          <Line
            type="monotone"
            dataKey="benchmark"
            name="buy & hold"
            stroke="oklch(0.68 0.012 80)"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
