# Golden replay fixtures

`golden-bars.json` is deliberately synthetic, not recorded market data.

Synthetic bars are reproducible forever, contain no licensing question, and can
be authored to exercise specific engine paths (gap-through, same-session
stop-and-target, max-hold expiry) that real data would only supply by luck.

The scenario spans 2026-07-01 to 2026-07-15 on the US calendar and covers:

- SOLID — trends up, hits its target on session 6
- GAPPY — gaps below its stop on session 3
- CHOPPY — never touches either level, force-closed at max hold
- WHIPSAW — touches both stop and target in one session

Note 2026-07-03 is a US market holiday (observed Independence Day), so it does
not appear in any series.

If a change to the engine moves the asserted final equity, that is the test
doing its job. Update the number only after confirming the new behaviour is
intended, and say why in the commit message.
