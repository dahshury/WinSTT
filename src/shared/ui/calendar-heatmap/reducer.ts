import type { DateRange, ViewMode } from "./types";

interface CalendarState {
	anchors: Date[];
	hovered: Date | null;
	internalSelected: Date | DateRange | null;
	// Records the externally-supplied `month` prop timestamp we've already
	// synced anchors to. Storing this in state (instead of a ref) and comparing
	// during render lets us implement the React-canonical "adjusting some state
	// when a prop changes" pattern without a useEffect or a ref-read-in-render.
	// When WE initiate a change via updateAnchor, we pre-record the new
	// timestamp so the inevitable parent re-emit of `month` doesn't clobber
	// independent navigation of the right calendar.
	syncedMonthTs: number | undefined;
	viewModes: ViewMode[];
}

type CalendarAction =
	| { type: "selected/set"; value: Date | DateRange | null }
	| { type: "hovered/set"; value: Date | null }
	| { type: "anchors/set"; value: Date[] }
	| { type: "anchors/updateOne"; index: number; value: Date }
	| { type: "viewMode/setOne"; index: number; value: ViewMode }
	| {
			type: "monthProp/sync";
			incomingTs: number | undefined;
			anchorsOverride: Date[] | null;
	  };

function calendarReducer(
	state: CalendarState,
	action: CalendarAction,
): CalendarState {
	switch (action.type) {
		case "selected/set":
			return { ...state, internalSelected: action.value };
		case "hovered/set":
			return state.hovered === action.value
				? state
				: { ...state, hovered: action.value };
		case "anchors/set":
			return {
				...state,
				anchors: action.value,
				syncedMonthTs: action.value[0]?.getTime(),
			};
		case "anchors/updateOne": {
			const next = [...state.anchors];
			next[action.index] = action.value;
			const patch: Partial<CalendarState> =
				action.index === 0 ? { syncedMonthTs: action.value.getTime() } : {};
			return { ...state, anchors: next, ...patch };
		}
		case "viewMode/setOne": {
			const next = [...state.viewModes];
			next[action.index] = action.value;
			return { ...state, viewModes: next };
		}
		case "monthProp/sync":
			if (action.anchorsOverride) {
				return {
					...state,
					anchors: action.anchorsOverride,
					syncedMonthTs: action.incomingTs,
				};
			}
			return { ...state, syncedMonthTs: action.incomingTs };
		default:
			return state;
	}
}

export { type CalendarAction, calendarReducer, type CalendarState };
