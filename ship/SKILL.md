---
name: ship
description: Decide whether the evidence actually supports calling the work complete.
license: MIT
metadata:
  version: "0.2"
  source: https://weindie.com/ship
---

# /ship

**Does the evidence support calling this done?**

"Done" is a claim about evidence, not a feeling about code. Work is most often
reported complete when the main path has been demonstrated and the rest has been
reasoned about. This skill separates what has actually been verified from what is
being assumed, and gives a verdict either way.

## Useful when

- Work is about to be reported as finished, merged or handed over.
- Several requirements were requested and only some are visibly exercised.
- The cost of being wrong is higher than the cost of one more check.
- An agent has said "done" without saying how it knows.

## Probably not needed when

- The change is trivial and its effect is directly visible.
- Verification has just happened and nothing has changed since.
- The work is explicitly exploratory and not being claimed as finished.

READY is a legitimate verdict. If the evidence is there, say so without inventing
a caveat to look thorough.

## How to run the check

1. **List what was asked for.** Every distinct requested behaviour, including the
   ones mentioned in passing.
2. **Attach evidence to each one.** What specifically demonstrates it works — a
   test that ran, output observed, a path exercised. Name it.
3. **Mark the gaps.** Anything supported only by reading the code is unverified,
   however confident the reading is.
4. **Check what else moved.** Was anything else changed or broken along the way?
5. **Give a verdict:** READY, or NOT READY with the specific missing evidence.

## Reporting

- Distinguish "verified" from "believed" in plain words.
- Do not hedge. "Should work" reads as verified without being verified.
  A reader cannot tell which a hedge means, so resolve it: verified, or believed.
- Quote real evidence — a failing test's output beats a summary of it.
- Name the smallest thing that would close each gap.
- Never report a check as passing if it was skipped, or did not run.

## Defaults you can change

These are the adjustable lines of this skill. A customised copy from
<https://weindie.com/ship> replaces them and records what changed.

- **Evidence level.** Require each requested behaviour to be demonstrated by something that actually ran; reasoning about the code is not evidence.
- **Fixing failures.** When a check fails, fix it, re-run it, and report both the failure and the fix.
- **Manual verification.** Where a behaviour cannot be checked automatically, say so and describe the manual check the human should run.
- **Unresolved issues.** A known unresolved issue does not block READY, provided it is listed explicitly and is unrelated to the requested behaviour.
