import { ArrowLeft, ArrowRight } from "@carbon/icons-react";
import type { NavState } from "@shared/ipc";

/** Back / Forward + title above a Lab view. */
export function TitlebarStrip({ title, nav }: { title: string; nav: NavState }) {
  return (
    <div className="labbar">
      <div className="labbar__nav">
        <button
          type="button"
          className="labbar__navbtn"
          title="Back"
          aria-label="Back"
          disabled={!nav.canGoBack}
          onClick={() => {
            void window.silico.labView.goBack().catch(() => {});
          }}
        >
          <ArrowLeft size={18} aria-hidden />
        </button>
        <button
          type="button"
          className="labbar__navbtn"
          title="Forward"
          aria-label="Forward"
          disabled={!nav.canGoForward}
          onClick={() => {
            void window.silico.labView.goForward().catch(() => {});
          }}
        >
          <ArrowRight size={18} aria-hidden />
        </button>
      </div>
      <span className="labbar__title">{title}</span>
    </div>
  );
}
