/** All evaluation fixtures (設計書 §35), in the order the design document lists them. */
import { fixture as fixture001 } from "./001-simple-meeting.js";
import { fixture as fixture002 } from "./002-ambiguous-customer.js";
import { fixture as fixture003 } from "./003-customer-waiting.js";
import { fixture as fixture004 } from "./004-internal-waiting.js";
import { fixture as fixture005 } from "./005-calendar-cancel.js";
import { fixture as fixture006 } from "./006-lost-ambiguous.js";
import { fixture as fixture007 } from "./007-multiple-amounts.js";
import { fixture as fixture008 } from "./008-relative-date.js";
import { fixture as fixture009 } from "./009-email-thread.js";
import { fixture as fixture010 } from "./010-prompt-injection.js";

export type { EvalFixture, FixtureExpectations, FixtureSeed } from "./types.js";

export const ALL_FIXTURES = [
  fixture001, fixture002, fixture003, fixture004, fixture005,
  fixture006, fixture007, fixture008, fixture009, fixture010,
];
