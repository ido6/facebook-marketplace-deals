# Marketplace deals – reference

## Queries

Israeli sellers mix languages, drop model words, and misspell. The server already folds common Hebrew brand names (אייפון→iphone, סמסונג→samsung, פלייסטיישן→playstation, פרו→pro, מקס→max, מיני→mini, גיגה→GB) for relevance and grouping, but Facebook's own search is literal, so each spelling you pass finds different listings.

| Want | queries | exclude |
|---|---|---|
| iPhone 13 Pro | `iphone 13 pro`, `אייפון 13 פרו` | case, כיסוי, מגן |
| Galaxy S23 | `galaxy s23`, `samsung s23`, `גלקסי s23` | כיסוי, case |
| PS5 | `ps5`, `playstation 5`, `פלייסטיישן 5` | משחק, game, controller, שלט |
| MacBook Air M2 | `macbook air m2`, `מקבוק אייר m2` | case, מטען |
| Road bike | `אופני כביש`, `road bike` | ילדים, kids |
| Sofa | `ספה`, `sofa`, `ספה תלת` | כרית |

City slugs: `telaviv`, `jerusalem`, `haifa`, `beersheba`, `rishonlezion`, `petahtikva`, `ashdod`, `netanya`, or a numeric location id from a Marketplace URL. Logged out, Facebook spreads results nationally anyway; logging in makes location and `radius_km` tighter.

## Report

```
## <product> — Marketplace snapshot (<city>, <date>)
Retail new: ₪X (source) · typical used: ₪Y · Marketplace median for <variant>: ₪Z (n=…)

| # | Price | Listing | Where | Age | Condition | Verdict | Open at | Fair |
|---|-------|---------|-------|-----|-----------|---------|---------|------|

Avoid: <count> suspicious — <one line per pattern, e.g. "3× priced at 40% of median, likely bait">
Ask first: <listing → the exact question>
Messages (paste in Messenger):
- #1: <message>
Reports: <html path> · <csv path>
Asking prices, not sold prices: expect to close 5–15% lower.
```

Message templates (fill in, keep short and polite):

- Hebrew opener: `היי, ה<פריט> עוד זמין? אם כן, אני יכול להגיע היום/מחר לראות. מוכן/ה ל-<opening> ₪?`
- Hebrew with a question: `היי, מתעניין ב<פריט>. מה בריאות הסוללה ויש חשבונית/אחריות? אם הכל תקין אשמח לסגור ב-<opening> ₪ באיסוף.`
- English: `Hi, is the <item> still available? I can pick up today/tomorrow. Would you take ₪<opening>?`

Meet in a public place, test the item (for phones: iCloud/Google account signed out, IMEI matches the box, battery health), pay on handover.

## Scheduling

- Inside Claude: `/schedule` (cloud routine) or `/loop 6h` running `marketplace_check_watches`.
- Without Claude (Windows Task Scheduler, every morning at 08:00):
  `schtasks /Create /SC DAILY /ST 08:00 /TN "Marketplace watches" /TR "cmd /c node C:\path\to\facebook-marketplace-deals\dist\cli.js check-watches > %USERPROFILE%\.fb-marketplace-mcp\last-check.txt 2>&1"`
  Exit code 2 means the Facebook session expired: run `node dist/cli.js login`.
