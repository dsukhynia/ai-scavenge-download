# Demo Script — Self-Healing Document Download Automation

*Narration script for the recorded demo. Cleaned up from dictated notes;
content verified against the current codebase (`README.md`, `mock-sites/server.ts`,
`docs/FLOW.md`).*

---

## Introduction

This is a demo of a proof-of-concept (POC) application that processes a
predefined list of websites and, for each one, locates and downloads a file
from its menu using an agentic function.

I've prepared three basic demo websites that provide a file to download. Each
site has slightly different navigation logic to reach that file:

- **Site A** has a standard top menu with a Reports section. The Reports page
  provides a download button that downloads the file.
- **Site B** has no menu at all — it's simply a button that downloads the file
  right away.
- **Site C** also has a top menu, but it's slightly more complex: it has a
  Document Center with a dropdown. Selecting a period from the dropdown and
  clicking Apply reveals the link that leads to the file download.

The application is built on the Node.js platform using the Claude API. I've
also created a basic HTML console that helps visualize what's happening and
provides controls for the application flow — I'll be using it throughout this
demo to trigger each run and watch the logs stream in live.

---

## Use Case 1 — Initial Discovery Run

The application supports three use cases. The first is the initial run, when
nothing has been executed before and the application has no history of any
downloads. In this case, the application uses an LLM to navigate the website
and locate the file to download.

I'm going to go ahead and start the initial cycle from the console.

The way it works: the application sends the page's accessibility tree to the
LLM, and the LLM responds with the actions that need to be taken to navigate
further. In other words, all the actions are performed by the application —
the LLM is only responsible for orchestrating those actions, i.e. telling the
application what to do.

Meanwhile, our first use case is complete. It produces two artifacts for each
website: one is the downloaded file itself, and the other is the recipe — a
JSON file describing every action that was taken to successfully download the
document.

The idea is that later we can perform that same set of actions and get the
same result without involving the LLM again, which saves us the cost of a
model call on every run.

---

## Use Case 2 — Replay

Now that we have a recipe, we can move on to our second use case: replaying
the recipes we've already collected to download the files without involving
the LLM.

As you can see, the files were downloaded much faster this time, because
there was no LLM analysis involved — it's just plain, static code execution,
and we get the same result.

---

## Use Case 3 — Healing a Broken Recipe

The third scenario covers what happens when a recipe stops working — for
example, if someone changed something on the website and the recipe we have
so far no longer produces the correct result.

*[Operator runs `BREAK=a npm run sites` to rename Site A's download link.]*

Now I'll break Site A by renaming its download link, simulating a change the
site owner might make.

Now that the website is broken, the idea is that the system will use the
**heal** process: if it identifies that the recipe did not produce a valid
result, it will discard the recipe and call on the LLM again to create and
verify a new one. Let's see how that works.

As you can see, processing Site A took longer this time, because the system
correctly identified that the recipe was no longer valid and had to
regenerate it using the LLM once again.

---

## Wrap-up

That covers all three use cases: an initial LLM-driven discovery, a fast
deterministic replay with no model involved, and a self-healing recovery when
a site changes underneath us. The result is a system that only pays for LLM
time when something actually needs figuring out — every routine run is just
plain code. Thanks for watching.
