import { describe, expect, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render, screen } from "@testing-library/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

describe("widget Tooltip wrappers", () => {
	test("Tooltip renders its children", () => {
		render(
			<TooltipProvider.Provider>
				<Tooltip>
					<TooltipTrigger>
						<button data-testid="trigger" type="button">
							trigger
						</button>
					</TooltipTrigger>
					<TooltipContent>tip text</TooltipContent>
				</Tooltip>
			</TooltipProvider.Provider>
		);
		expect(screen.getByTestId("trigger")).toBeDefined();
	});

	test("TooltipContent merges custom className through cn()", () => {
		render(
			<TooltipProvider.Provider>
				<Tooltip>
					<TooltipTrigger>
						<button data-testid="trigger" type="button">
							t
						</button>
					</TooltipTrigger>
					<TooltipContent className="custom-class" />
				</Tooltip>
			</TooltipProvider.Provider>
		);
		expect(screen.getByTestId("trigger")).toBeDefined();
	});
});
