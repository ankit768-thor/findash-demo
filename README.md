# FinDash: demo

A live demo of **FinDash**, a private bank-statement analyser for Indian bank accounts.

**▶ Open the demo: https://ankit768-thor.github.io/findash-demo/**

All data here is **made up**: a fictional "Demo User" with a salary account and a spending
account, October 2024 to October 2026 (1,027 transactions). No real bank data is involved.
The real app runs on your own computer, reads your statements (CSV, Excel or password-protected
PDF) and never sends them anywhere. This demo is read-only: uploading, re-importing and
changing categories only work in the real app.

## What the demo shows

| Page | What you'll see |
|---|---|
| **Overview** | Money in, money out, net cash flow, closing balance, average monthly spending and savings rate. Each has a comparison with the same period last year, a 12-month trend and the formula behind it. Also income vs spending by month, top categories, balance trend, financial-health ratios, largest and recent transactions |
| **Transactions** | Search, 8 filters, quick chips, sorting and pages. Click any row for its details, category confidence, recurring series and similar payments. CSV export |
| **Cash flow** | Monthly net cash flow, balance trend, and a month-by-month table proving that *opening balance + money in − money out = closing balance* |
| **Income** | Salary (with a raise and a bonus), interest and a tax refund, kept separate from refunds, own-account transfers and money from friends |
| **Spending** | 20+ categories, essential vs discretionary, top merchants, a monthly category heatmap, weekday vs weekend, and what changed |
| **Recurring & bills** | Rent, SIPs, insurance, subscriptions and an EMI that has ended. Each shows frequency, next estimated date, yearly cost and confidence, plus fixed obligations as a share of income |
| **Insights & alerts** | Evidence-backed insights (what changed, by how much, why it matters), and unusual transactions with the reason and baseline: a big one-off purchase, a duplicate-looking charge, a burst of orders |
| **Compare** | Any two periods, scaled fairly when their lengths differ; category vs category; merchant vs merchant |
| **Counterparties** | People and merchants, searchable by name or phone/UPI handle, with money in, money out and net per person |
| **Ask** | Plain-English questions answered from the data, e.g. *"How much did I spend on food delivery last month?"* |
| **Settings & data** | Data-quality report: balances reconcile on every day, plus files read and rows skipped |

Also in the data: transfers between the two accounts (netted out), a failed UPI payment and
its reversal (excluded), a merchant refund, an FD and SIPs (counted as savings, not spending),
ATM cash, card bills and a yearly bank charge. Light and dark themes; works on a phone.

## How the numbers are defined

- **Earned income**: salary, interest, freelance and dividends. Never refunds, transfers or money from people.
- **Spending**: expense payments minus refunds. Investments, own-account transfers and person-to-person money are not spending.
- **Savings rate**: (earned income − spending) ÷ earned income.
