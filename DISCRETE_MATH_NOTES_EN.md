# Discrete Mathematics & Mathematical Proofs Notes

**Learner:** Zhang Xin  
**Status:** In progress  
**Course:** Mathematical Proofs, Coursera (Case Western Reserve University)

## 1. What is a proof?

A proof is a convincing argument, expressed in the language of mathematics, that a statement is true.

Learning proofs has three stages:

1. Understand individual proof techniques.
2. Use the techniques to read and write proofs.
3. Become fluent enough to focus on more creative mathematical ideas.

Practice is essential. Watching a lecture is not enough; I need to complete exercises and compare my reasoning with the solutions.

## 2. Statements

A statement is a sentence or mathematical expression that is either true or false.

Examples:

- The angles of a plane triangle add up to 180 degrees.
- There exists a real number `x` such that `x = e^(-x)`.

## 3. Implication and the truth table

The following expressions have the same meaning:

- If `A`, then `B`.
- `A` implies `B`.
- `A => B`.

Here, `A` is the **hypothesis** and `B` is the **conclusion**.

| A | B | A => B |
|---|---|--------|
| True | True | True |
| True | False | False |
| False | True | True |
| False | False | True |

The key rule is:

> An implication is false only when the hypothesis is true and the conclusion is false.

## 4. Direct proof template

To prove `A => B`:

1. Assume that `A` is true.
2. Use definitions, known facts, and logical steps to show that `B` is true.
3. Conclude that `A => B` is true.

### Example

Claim: If a real number `x > 2`, then `x^2 > 4`.

Proof idea:

1. Assume `x > 2`.
2. Then `x` is positive, so squaring preserves the inequality.
3. Therefore `x^2 > 2^2 = 4`.
4. Hence the claim is true.

## 5. Connection to computer science

Formal statements and proofs are useful for reasoning about algorithms. In later study, I will connect these ideas to:

- graph algorithms such as breadth-first search (BFS) and depth-first search (DFS);
- correctness arguments for algorithms;
- time-complexity notation such as Big-O.

## Learning log

- [x] Understand the definition of a proof.
- [x] Identify a hypothesis and a conclusion.
- [x] Read the truth table for an implication.
- [x] Understand the structure of a direct proof.
- [ ] Complete the remaining course modules and graded assessments.
- [ ] Build a small Python BFS/DFS project.
- [ ] Add the certificate after the course is completed.

