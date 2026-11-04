<div align="center">

# Prize Pool

**An AI tournament treasurer for community esports: winners get paid seconds after the final, and only when code
has verified the result.**

</div>

> Work in progress. A full README with a demo, video and setup guide is coming.

## The problem
Grassroots tournament organizers (Discord communities, small leagues) still collect and pay prize pools by hand. Payouts
take days, and organizers get accused of keeping the money.

## What Prize Pool does
1. The organizer describes the event in plain English; Claude compiles it into a validated tournament spec.
2. Fans and sponsors fund the pool: contributions are **PayPal authorizations** (held, not charged), and sponsor
   pledges are **PayPal invoices**. If the event is cancelled, every hold is voided automatically.
3. Every reported result is checked **in code** against public match data: **Dota 2** through OpenDota (rosters, sides,
   winner, league, time window) or **chess** through Lichess (players or issued game, termination, variant, window).
4. The bracket advances; disputes are ruled against the organizer's own rulebook, with the match facts shown.
5. After the final, a **PayPal Payouts** batch pays every winning player. A policy gate recomputes every amount and
   recipient first, so no model can redirect money.

Pools are funded by contributions and sponsors only: no entry fees, no betting.

## Status
- [x] Result sources for Dota 2 (OpenDota) and chess (Lichess), bracket with draws, exact cent splits, payout policy gate
      (`server/src`, tested against a real Dota 2 match and a real Lichess game)
- [ ] PayPal sandbox integration (Orders v2 authorize/capture/void, Payouts, Invoicing, webhooks)
- [ ] Claude spec compiler and ruling agent
- [ ] Organizer console and public tournament page with an AG Grid ledger

## Develop
```bash
cd server
npm install
npm test
```

Copy `.env.example` to `.env` and fill in the PayPal sandbox and Anthropic keys.

## License
MIT. See [LICENSE](LICENSE).
