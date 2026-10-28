# Product Vision: A Personal Reading Layer for Hacker News

## Vision
Give every Hacker News reader a durable, personal memory of what matters to them—without requiring constant attention or giving up control of their tools.

## Problem and Opportunity
Hacker News rewards frequent visits, but interesting reading and available attention rarely arrive at the same time. A story that would have been valuable to a particular reader can disappear from view while that person is busy, away, or simply reading something else. Returning to the site then means starting again with whatever happens to be visible.

The shared front page also cannot represent every reader’s interests. Deep technical work, niche topics, thoughtful discussions, and unexpected ideas have different value to different people. Explicit favorites and popularity signals capture only part of that value.

There is now an opportunity to build a personal reading memory that works continuously, learns from how someone actually reads, and remains under that reader’s control. It should make absence from HN feel safe rather than costly.

## Who This Is For
The product is for existing Hacker News regulars who are comfortable with developer tools and want more control over their reading experience. They may read in bursts, have interests that differ from the front page, and dislike the feeling that a few busy days caused them to lose worthwhile stories.

They value open-source software and are willing to configure a personal service and an LLM endpoint. They may run it on a laptop, but they may prefer a personal server with a custom domain so collection continues while their laptop is off.

The initial audience is not every casual news reader. The product should be easy for its technical audience to install and operate, without pretending that a self-hosted service requires no technical knowledge.

## The Future Experience
A reader can leave Hacker News for a week without losing the week. Their personal reader keeps collecting stories, considers them against that reader’s evolving interests, and preserves the likely matches. When they return, they find a complete, prioritized reading queue rather than a short digest that has already discarded most of the possibilities.

The reader decides how far through the queue to go. Nothing is presented as an obligation, but the product does not confuse brevity with peace of mind: its job is to preserve the reading that matters and make the order useful.

Personalization begins with natural use. Reading, skipping, voting, and other HN activity help the system learn, while explicit interests and topic blacklists let the reader state preferences directly. A suggestion need not interrupt the reading experience with an explanation, but its reasoning should be available when the reader wants to understand or correct it.

The queue is personal without becoming narrow. Alongside strong matches, it deliberately preserves some surprising stories that an interest model might otherwise exclude. Discovery remains part of the value of HN.

The product is a reading layer, not a replacement community. A person can use it to choose and return to worthwhile reading while continuing to participate in Hacker News itself.

## Value and Differentiation
The essential promise is: **time away from Hacker News should not cost you the stories that would have mattered to you.**

This differs from a universal ranking because value is defined by each reader. It differs from a brief personalized digest because likely matches remain available in a complete queue. It differs from a black-box recommendation feed because natural learning is combined with explanations and direct control. It differs from a purely familiar feed because serendipity is intentional.

Just as importantly, the reading memory belongs to the reader. It runs on infrastructure they choose, with open-source code and an LLM provider they select.

## Product Principles
- **Let the reader define value.** Do not impose one editorial idea of what makes a story worthwhile.
- **Replace compulsive checking with continuity.** The product should make it easier to step away, not create another stream that demands constant attention.
- **Learn naturally, explain on request, accept correction.** Reading behavior, stated interests, and exclusions each have a role.
- **Preserve a complete memory, not just highlights.** A useful queue should prioritize without silently reducing the experience to a handful of stories.
- **Make room for surprise.** Accurate prediction should not erase discovery.
- **Keep ownership with the reader.** Running on a laptop or a personal server should both be first-class experiences. Ownership means control over where the product runs and which model it uses, not a promise that no data ever leaves the machine.
- **Be open and approachable.** The code should be inspectable, and setup should be straightforward for HN regulars who already use developer tools.

## Direction and Non-Goals
The ambition is to become the trusted personal reading memory for Hacker News: continuously present while the reader is away, shaped by that reader, and available on infrastructure they control.

It is not a replacement for Hacker News discussions or community participation. It is not a general-purpose aggregator for every news source, nor a universal tech-news product with HN as merely its first source. It is not primarily a short daily briefing, a hosted multi-user service, or a no-configuration product for non-technical readers.

External LLM processing is compatible with the vision. The reader should understand and choose that arrangement, but strict local-only inference is not a defining requirement.

## Long-Term Outcomes
The vision is being realized when:

- HN regulars can ignore the site for days and return without anxiety about lost reading.
- Readers find valuable niche, deep, and surprising stories that a popularity-driven visit would not have reliably surfaced for them.
- People trust the queue because they can understand its choices, correct its mistakes, and see it adapt as their interests change.
- A complete backlog feels like an available personal library rather than a demand to catch up.
- Readers can keep continuous collection on a laptop or personal server without giving up ownership of the system.
- Other technical HN readers choose to run and modify the open-source product because its personal reading memory is useful beyond its creator’s own preferences.

## Assumptions and Open Questions
- Hacker News’s official API provides public data, but the product’s account-level observation depends on browser or session integration. Its reliability and acceptability to HN remain to be established.
- Reading behavior is an imperfect signal. Time spent reading does not always mean enjoyment, and a skip does not always mean lack of interest. The product must learn despite that ambiguity.
- “Do not miss what matters” is an aspiration, not a guarantee. It remains to be seen how well the system can avoid both false confidence and an excessively broad queue.
- A complete queue can still overwhelm. Prioritization, organization, and the reader’s relationship to the backlog will determine whether the experience feels calm.
- Recommendation quality, operating cost, and dependence on an external LLM remain open concerns. The amount and kind of reader context a model needs must be made clear.
- The initial audience’s preference for self-hosting and model choice may outweigh strict privacy concerns, but that assumption should be tested with readers beyond the creator.

## Sources
- [Official Hacker News API documentation](https://github.com/HackerNews/API) — describes the public HN data available through the API and its public user fields.
- [Show HN: A personalized HN feed that learns from your favorites](https://news.ycombinator.com/item?id=45349668) — a community example of personalization driven by explicit favorites, used to understand adjacent approaches.
- [daily.dev vs Hacker News: an honest comparison](https://daily.dev/blog/daily-dev-vs-hacker-news-comparison) — a vendor perspective on the difference between a personalized multi-source developer feed and HN’s shared front page.
