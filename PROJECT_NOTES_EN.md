# Project Notes

## 1. Why I started this project

My mother runs a small tofu-products business. Before this project, she mainly
copied customer orders by hand. Entering the daily orders took about two hours.

At the end of each month, she also had to organise every customer's orders and
calculate the amounts manually. This was a large and exhausting workload, and
she often did not have enough time to rest.

I wanted to build a simple and practical order management system that could
reduce repetitive work, save her time and make the process less stressful.

## 2. The improvement

With the system, daily order entry takes about half an hour instead of around two
hours.

Customer information, products, prices, orders and monthly summaries are now
kept in one place. This reduces handwritten copying and repeated calculations,
and makes month-end reconciliation clearer.

## 3. Main features

The main features I focused on are:

- customer management;
- product management;
- customer-specific prices;
- order entry;
- copying the previous order;
- historical order lookup;
- monthly summaries and closing;
- payment status tracking;
- continuous-form order printing.

## 4. Important design decisions

### Store money as cents

Prices and totals are stored as integer cents rather than decimal floating-point
values. For example, CNY 4.25 is stored as 425 cents. This avoids small
floating-point errors in order calculations.

### Store quantities as thousandths

Quantities are stored as integer thousandths of a jin. For example, 1.25 jin is
stored as 1250. The amount is calculated as:

quantity in thousandths × price in cents ÷ 1000

The result is rounded to the nearest cent.

### Preserve the price at the time of ordering

Each order keeps the product name, customer, price and calculated amount from the
time the order was created. If the product price changes later, old orders are
not rewritten.

### Recalculate copied orders using the current price

Copying the previous order reduces repeated entry, but the system uses the
customer's current price when creating the new order. This prevents an old price
from being carried into a new order by mistake.

### Treat printing as part of the requirement

The business uses fixed-size continuous printer paper. The printing page
therefore uses millimetre-based coordinates to control the output position
precisely.

## 5. My involvement

I studied my mother's daily workflow, identified the requirements for customer
prices, order entry, copying orders, monthly summaries and printing, and checked
the calculations with concrete examples.

Codex was used to generate and refactor parts of the implementation. I treated
the generated code as a first draft, reviewed the main logic, checked whether
the behaviour matched the real workflow, and continued improving the
documentation and synthetic demo data.

## 6. Limitations and future improvements

This is a local-first prototype for my mother's daily order management. It is
not yet a hosted system designed for many users working at the same time.

Possible future improvements include user authentication, role-based
permissions, cloud synchronisation and more complete operation records.

## 7. What I learned

This project was my first attempt to turn a real problem in my family into
software requirements.

I learned about data modelling, input validation, integer money calculations,
data persistence, historical records and print-layout design.

More importantly, I learned that software development is not only about writing
code. It also means understanding what a user actually struggles with and
designing a tool that saves time and solves that problem.
