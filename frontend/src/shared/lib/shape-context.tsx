"use client";

import { createContext, type ReactNode, useContext } from "react";

export interface Shape {
	bg: string;
	input: string;
}

const DEFAULT_SHAPE: Shape = {
	bg: "rounded-xs",
	input: "rounded-xs",
};

const ShapeContext = createContext<Shape>(DEFAULT_SHAPE);

export function ShapeProvider({ children, value }: { children: ReactNode; value: Shape }) {
	return <ShapeContext.Provider value={value}>{children}</ShapeContext.Provider>;
}

export function useShape(): Shape {
	return useContext(ShapeContext);
}
