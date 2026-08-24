declare module 'picomatch' {
	interface MatcherOptions {
		readonly dot?: boolean | undefined;
		readonly basename?: boolean | undefined;
	}
	function picomatch(
		glob: string,
		options?: MatcherOptions
	): (value: string) => boolean;
	export = picomatch;
}
