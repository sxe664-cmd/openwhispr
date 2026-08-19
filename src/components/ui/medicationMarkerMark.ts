import { Mark } from "@tiptap/core";

export const MEDICATION_MARKER_START = "[[OW_MEDICATION_START]]";
export const MEDICATION_MARKER_END = "[[OW_MEDICATION_END]]";

const MEDICATION_MARK_OPEN_TOKEN = "ow_medication_open";
const MEDICATION_MARK_CLOSE_TOKEN = "ow_medication_close";
const MEDICATION_MARK_ATTRIBUTE = "data-ow-medication";

type InlineToken = {
  markup?: string;
};

type InlineState = {
  src: string;
  pos: number;
  push: (type: string, tag: string, nesting: number) => InlineToken;
  owMedicationMarkerOpen?: boolean;
};

type MarkdownItLike = {
  inline: {
    ruler: {
      before: (
        before: string,
        name: string,
        rule: (state: InlineState, silent: boolean) => boolean
      ) => void;
    };
  };
  renderer: {
    rules: Record<string, (...args: unknown[]) => string>;
  };
};

const medicationMarkerMarkdown = {
  serialize: {
    open: MEDICATION_MARKER_START,
    close: MEDICATION_MARKER_END,
  },
  parse: {
    setup(markdownit: MarkdownItLike) {
      // MarkdownParser.setup runs every time content is parsed. Do not add the
      // same inline rule repeatedly to a long-lived MarkdownIt instance.
      if (markdownit.renderer.rules[MEDICATION_MARK_OPEN_TOKEN]) return;

      markdownit.inline.ruler.before("text", "ow_medication_marker", (state, silent) => {
        const { src, pos } = state;

        if (src.startsWith(MEDICATION_MARKER_START, pos)) {
          // Only consume an opening marker when its closing pair is in the same
          // inline source. Otherwise the original marker remains literal.
          const closePos = src.indexOf(MEDICATION_MARKER_END, pos + MEDICATION_MARKER_START.length);
          if (closePos < 0) return false;

          if (!silent) {
            const token = state.push(MEDICATION_MARK_OPEN_TOKEN, "span", 1);
            token.markup = MEDICATION_MARKER_START;
            state.owMedicationMarkerOpen = true;
          }
          state.pos += MEDICATION_MARKER_START.length;
          return true;
        }

        if (
          src.startsWith(MEDICATION_MARKER_END, pos) &&
          state.owMedicationMarkerOpen
        ) {
          if (!silent) {
            const token = state.push(MEDICATION_MARK_CLOSE_TOKEN, "span", -1);
            token.markup = MEDICATION_MARKER_END;
            state.owMedicationMarkerOpen = false;
          }
          state.pos += MEDICATION_MARKER_END.length;
          return true;
        }

        return false;
      });

      markdownit.renderer.rules[MEDICATION_MARK_OPEN_TOKEN] = () =>
        `<span ${MEDICATION_MARK_ATTRIBUTE}="true">`;
      markdownit.renderer.rules[MEDICATION_MARK_CLOSE_TOKEN] = () => "</span>";
    },
  },
};

export const medicationMarkerMarkdownSpec = medicationMarkerMarkdown;

export const MedicationMarkerMark = Mark.create({
  name: "owMedication",
  inclusive: false,

  parseHTML() {
    return [{ tag: `span[${MEDICATION_MARK_ATTRIBUTE}="true"]` }];
  },

  renderHTML() {
    return ["span", { [MEDICATION_MARK_ATTRIBUTE]: "true" }, 0];
  },

  addStorage() {
    return {
      markdown: medicationMarkerMarkdown,
    };
  },
});
