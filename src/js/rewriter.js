/* Eval Villain just jams this rewriter function into the loading page, withaa
 * some JSON as CONFIG. Normally Firefox does this for you from the
 * background.js file. But you could always copy paste this code anywhere you
 * want. Such as into a proxie'd response or electron instramentation.
 */
const rewriter = function(CONFIG) {
	// handled this way to preserve encoding...
	function getAllQueryParams(search) {
		return search.substr(search[0] == '?'? 1: 0)
			.split("&").map(x => x.split(/=(.*)/s));
	}

	class SourceFifo {
		constructor(limit) {
			this.limit = limit;
			this.fifo = [];
			this.set = new Set();
			this.removed = 0;
		}

		nq(sObj) {
			this.set.add(sObj.search);
			this.fifo.push(sObj);
			while (this.set.size > this.limit) {
				this.removed++;
				this.dq();
			}
			return this.removed;
		}

		dq() {
			const last = this.fifo.shift();
			this.set.delete(last.search);
			return last;
		}

		has(x) {
			return this.set.has(x);
		}

		*genAllMatches(str) {
			for (const sObj of this.fifo) {
				if (str.includes(sObj.search)) {
					yield sObj;
				}
			}
		}
	}

	/** hold all interest fifos */
	const ALLSOURCES = {}; // Used to hold all interest Fifo's

	function strSpliter(str, needle) {
		const ret = [];
		str.split(needle).forEach((x, index, arr)=> {
			ret.push(x)
			if (index != arr.length-1) {
				ret.push(needle)
			}
		});
		return ret;
	}

	function regexSpliter(str, needle) {
		const ret = [];
		if (needle.global == false) {
			// not global regex, so just split into two on first
			needle.lastIndex = 0;
			const m = needle.exec(str)[0];
			const l = str.split(m);
			ret.push(l[0], m, l[1]);
		} else {
			let holder = str;
			let match = null;
			needle.lastIndex = 0;
			let prevLast = 0;

			while ((match = needle.exec(str)) != null) {
				const m = match[0];
				ret.push(holder.substr(0, holder.indexOf(m)));
				ret.push(m);
				holder = holder.substr(holder.indexOf(m)+m.length);
				if (prevLast >= needle.lastIndex) {
					real.warn("[EV] Attempting to highlight matches for this regex will cause infinite loop, stopping")
					break;
				}
				prevLast = needle.lastIndex;
			}
			ret.push(holder);
		}
		return ret;
	}

	/** Contains regex/str searches for needles/blacklists **/
	class NeedleBundle {

		/**
		 * Hold user defined needles, string/regex, to search sinks for.
		 * @param {string[]} needleList Array of needles, as strings
		 * @example
		 * // Needle bundle for substring `asdf` and regex `/asdf/gi`
		 * const x = new NeedleBundle(["asdf", "/asdf/gi"]);
		 **/
		constructor(needleList) {
			this.needles = [];
			this.regNeedle = [];
			const test = /^\/(.*)\/(i|g|gi|ig)?$/;
			for (const need of needleList) {
				const s = test.exec(need);
				if (s) {
					const reg = new RegExp(s[1],
						s[2] === undefined? "": s[2]);
					this.regNeedle.push(reg);
				} else {
					this.needles.push(need);
				}
			}
		}

		*genStrMatches(str) {
			for (const need of this.needles) {
				if (str.includes(need)) {
					yield need;
				}
			}
		}

		*genRegMatches(str) {
			for (const need of this.regNeedle) {
				need.lastIndex = 0; // just to be sure there is no funny buisness
				if (need.test(str)) {
					need.lastIndex = 0; // This line is important b/c JS regex holds a state secretly :(
					yield need;
				}
			}
		}

		*genMatches(str) {
			for (const match of this.genStrMatches(str)) {
				yield match;
			}
			for (const match of this.genRegMatches(str)) {
				yield match;
			}
		}

		matchAny(str) {
			for (const match of this.genMatches(str)) {
				if (match) {
					return true;
				}
			}
			return false;
		}
	}

	/** Everything that might make a particular sink interesting */
	class SearchBundle {
		/**
		 * Contains qualifications for sink to be considered interesting
		 * @param {NeedleBundle}	needles Needles ie user provided string/regex
		 * @param {object}	fifoBank Maps source name to `SourceFifo`
		 **/
		constructor(needles, fifoBank) {
			this.needles = needles;
			this.fifoBank = fifoBank
		}

		*genSplits(str) {
			for (const match of this.needles.genStrMatches(str)) {
				yield {
					name: "needle", decode:"",
					search: match,
					split: strSpliter(str, match)
				};
			}
			for (const match of this.needles.genRegMatches(str)) {
				yield {
					name: "needle", decode:"",
					search: match,
					split: regexSpliter(str, match)
				};
			}

			for (const [key, fifo] of Object.entries(this.fifoBank)) {
				for (const match of fifo.genAllMatches(str)) {
					yield {
						name: key,
						split: strSpliter(str, match.search),
						...match,
					};
				}
			}
		}
	}

	let rotateWarnAt = 8;

	// [VF-PATCH:CoreDecodeEngine] START
	const CoreDecodeEngine = (() => {
		const MAX_DEPTH = 10;

		/**
		 * Main entry point for decoding. Iteratively yields all possible decoded variants.
		 * @param {*} input The initial data to decode (string, object, array).
		 * @returns {Generator<[string, string]>} A generator yielding [decodedString, decodeDescription].
		 */
		function* deepDecode(input) {
			const seen = new Set();
			// The initial input itself isn't a "decoded" variant, so we start with decodeAny
			yield* decodeAny(input, "initial", seen, 0);
		}

		/**
		 * Dispatches to the correct decoder based on input type. Tracks seen values and depth.
		 */
		function* decodeAny(input, history, seen, depth) {
			if (depth > MAX_DEPTH) return;

			// Avoid processing the same primitive value or object reference in the same decoding chain
			const seenKey = typeof input === 'object' && input !== null ? JSON.stringify(input) : String(input);
			if (seen.has(seenKey)) return;
			if (seenKey.length > 0) seen.add(seenKey);


			if (typeof input === 'string') {
				yield* decodeAll(input, history, seen, depth);
			} else if (Array.isArray(input)) {
				yield* decodeArray(input, history, seen, depth);
			} else if (typeof input === 'object' && input !== null) {
				yield* decodeObject(input, history, seen, depth);
			}
		}

		function* decodeArray(arr, history, seen, depth) {
			for (let i = 0; i < arr.length; i++) {
				yield* decodeAny(arr[i], `${history}[${i}]`, seen, depth + 1);
			}
		}

		function* decodeObject(obj, history, seen, depth) {
			for (const key in obj) {
				if (Object.hasOwnProperty.call(obj, key)) {
					yield* decodeAny(obj[key], `${history}.${key}`, seen, depth + 1);
				}
			}
		}

		/**
		 * Applies all available decoding functions to a string.
		 */
		function* decodeAll(str, history, seen, depth) {
			if (typeof str !== 'string' || str.length === 0) return;

			const decoders = [
				urlDecode,
				htmlEntityDecode,
				jsUnicodeEscapeDecode,
				base64Decode,
				hexDecode,
				charCodeDecode,
				jsonParse,
				parseMultipart,
				octetStreamDecode,
			];

			for (const decoder of decoders) {
				try {
					for (const [decoded, type] of decoder(str)) {
						if (decoded === str) continue;
						const newHistory = history === "initial" ? type : `${history}->${type}`;

						// Yield the decoded string variant
						yield [decoded, newHistory];

						// And recursively decode it
						yield* decodeAny(decoded, newHistory, seen, depth + 1);
					}
				} catch (e) {
					// Ignore decoding errors and continue with other decoders
				}
			}
		}

		// --- Specific Decoding Functions ---

		function* urlDecode(str) {
			// [VF-PATCH:PreCheck] START
			if (!str.includes('%')) return;
			// [VF-PATCH:PreCheck] END
			let current = str;
			for (let i = 0; i < 10; i++) { // Limit nesting
				try {
					const decoded = decodeURIComponent(current);
					if (decoded !== current) {
						yield [decoded, `urlDecode(${i+1})`];
						current = decoded;
					} else {
						break;
					}
				} catch (e) {
					break;
				}
			}
		}

		function* htmlEntityDecode(str) {
			// [VF-PATCH:PreCheck] START
			if (!str.includes('&') || !/&[a-zA-Z0-9#]{1,10};/.test(str)) return;
			// [VF-PATCH:PreCheck] END
			// This is a browser-only implementation.
			if (typeof document === 'undefined') return;
			try {
				const textarea = document.createElement('textarea');
				textarea.innerHTML = str;
				const decoded = textarea.value;
				if (decoded !== str) {
					yield [decoded, 'htmlEntity'];
				}
			} catch (e) {}
		}

		function* jsUnicodeEscapeDecode(str) {
			// [VF-PATCH:PreCheck] START
			if (!str.includes('\\')) return;
			// [VF-PATCH:PreCheck] END
			// decodes \uXXXX and \xXX
			try {
				const decoded = str.replace(/\\u([a-fA-F0-9]{4})|\\x([a-fA-F0-9]{2})/g, (_, p1, p2) =>
					String.fromCharCode(parseInt(p1 || p2, 16))
				);
				if (decoded !== str) {
					yield [decoded, 'jsUnescape'];
				}
			} catch (e) {}
		}

		function* base64Decode(str) {
			// [VF-PATCH:PreCheck] START
			if (str.length < 4 || str.length % 4 !== 0 || !/^[A-Za-z0-9+/=\s_-]+$/.test(str)) return;
			// [VF-PATCH:PreCheck] END
			const standard = str.replace(/[-_]/g, m => m === '-' ? '+' : '/');
			try {
				const decoded = atob(standard);
				if (decoded) {
					yield [decoded, 'base64'];
				}
			} catch (e) {}
		}

		function* hexDecode(str) {
			// [VF-PATCH:PreCheck] START
			if (str.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(str)) return;
			// [VF-PATCH:PreCheck] END
			try {
				let decoded = '';
				for (let i = 0; i < str.length; i += 2) {
					decoded += String.fromCharCode(parseInt(str.substr(i, 2), 16));
				}
				 if (decoded) yield [decoded, 'hex'];
			} catch (e) {}
		}

		function* charCodeDecode(str) {
			// [VF-PATCH:PreCheck] START
			if (!/^\s*\d+(\s*,\s*\d+)*\s*$/.test(str)) return;
			// [VF-PATCH:PreCheck] END
			try {
				const decoded = String.fromCharCode.apply(null, str.trim().split(',').map(Number));
				if (decoded) yield [decoded, 'fromCharCode'];
			} catch (e) {}
		}

		function* jsonParse(str) {
			// [VF-PATCH:PreCheck] START
			const trimmed = str.trim();
			if ((!trimmed.startsWith('{') || !trimmed.endsWith('}')) && (!trimmed.startsWith('[') || !trimmed.endsWith(']'))) {
				return;
			}
			// [VF-PATCH:PreCheck] END
			try {
				const parsed = JSON.parse(trimmed);
				// We don't yield the object itself, but rather kick off a new decoding from that point
				const newSeen = new Set(); // Use a fresh 'seen' set for the sub-document
				yield* decodeAny(parsed, 'jsonParse', newSeen, 0);
			} catch (e) {}
		}

		function* parseMultipart(str) {
			// [VF-PATCH:PreCheck] START
			if (!str.includes('Content-Disposition')) return;
			// [VF-PATCH:PreCheck] END
			const boundaryMatch = str.match(/^--([^\r\n]+)/);
			if (!boundaryMatch) return;
			const boundary = boundaryMatch[1];
			const parts = str.split(new RegExp(`--${boundary}(--)?`));
			for (const part of parts) {
				const trimmedPart = part.trim();
				if (trimmedPart === '') continue;

				const headerMatch = trimmedPart.match(/Content-Disposition:[^\r\n]*; name="([^"]+)"/);
				if (!headerMatch) continue;

				const name = headerMatch[1];
				const contentSplit = trimmedPart.split('\r\n\r\n');
				if (contentSplit.length > 1) {
					const content = contentSplit.slice(1).join('\r\n\r\n');
					yield [content, `multipart(${name})`];
				}
			}
		}

		function* octetStreamDecode(str) {
			// This is a heuristic. Real octet-stream is binary, but here we handle string representations.
			// Attempt to decode as if it's a UTF-8 byte stream that has been URI-encoded.
			try {
				// A common pattern for binary data in strings is percent-encoding bytes.
				if (str.includes('%')) {
					 const decoded = decodeURIComponent(str);
					 if (decoded !== str) yield [decoded, 'octetStream(utf8)'];
				}
			} catch (e) {
				// A different heuristic: if it contains non-printable ASCII, treat as binary string.
				if (/[^\x20-\x7E\t\r\n]/.test(str)) {
					yield [str, 'octetStream(binary)'];
				}
			}
		}

		return { deepDecode };
	})();

	/*
	[VF-PATCH:CoreDecodeEngine-Tests]
	This is a small test suite to verify the functionality of the CoreDecodeEngine.
	To run, you would execute this in a browser console on a page where the rewriter is active,
	then call `runCoreDecodeTests()`.

	function runCoreDecodeTests() {
		const CDE = CoreDecodeEngine;
		console.log("--- Running CoreDecodeEngine Tests ---");

		const tests = [
			{
				name: "Nested URL Encoding",
				input: "https%253A%252F%252Fexample.com%253Fq%253Dtest",
				expected: ["https://example.com/?q=test"]
			},
			{
				name: "HTML Entity Encoding",
				input: "&lt;div&gt;Hello&lt;/div&gt;",
				expected: ["<div>Hello</div>"]
			},
			{
				name: "Base64 HTML Payload",
				input: "PGRpdiBvbmNsaWNrPSJhbGVydCgnSGVsbG8nKSI+Q2xpY2sgbWUhPC9kaXY+",
				expected: [`<div onclick="alert('Hello')">Click me!</div>`]
			},
			{
				name: "Multipart Form Data",
				input: `--boundary\r\nContent-Disposition: form-data; name="text"\r\n\r\nHello World\r\n--boundary\r\nContent-Disposition: form-data; name="json"\r\n\r\n{"a": "b"}\r\n--boundary--`,
				expected: ["Hello World", '{"a": "b"}', "b"]
			},
			{
				name: "Octet-stream (URL-encoded UTF8)",
				input: "S%C3%A9bastien",
				expected: ["Sébastien"],
			},
			{
				name: "Nested JSON with encoded fields",
				input: `{"user":{"name":"Sm9obiBEb2U=","profile":"%3Cscript%3Ealert(1)%3C%2Fscript%3E"}}`,
				expected: ["John Doe", "<script>alert(1)</script>"]
			},
			{
				name: "JS Unicode/Hex Escapes",
				input: "\\u0048\\u0065\\u006c\\u006c\\u006f\\x20\\u0057\\u006f\\u0072\\u006c\\u0064",
				expected: ["Hello World"]
			},
			{
				name: "CharCode Array",
				input: "72,101,108,108,111",
				expected: ["Hello"]
			},
			{
				name: "Complex Nested Case (b64->url->json)",
				input: "JTVCJTIySGVsbG8lMjUyMFdvcmxkJTIyJTVE", // base64: '["Hello%20World"]'
				expected: ["[\"Hello World\"]", "Hello World"]
			}
		];

		let passed = 0, failed = 0;

		tests.forEach(test => {
			console.group(`Test: ${test.name}`);
			const results = new Set();
			try {
				for (const [decoded, _] of CDE.deepDecode(test.input)) {
					results.add(decoded);
				}

				let testPassed = true;
				for (const exp of test.expected) {
					if (!results.has(exp)) {
						console.error(`FAIL: Expected to find "${exp}" but it was not decoded.`);
						testPassed = false;
					} else {
						console.log(`PASS: Found expected value "${exp}"`);
					}
				}
				if (testPassed) passed++; else failed++;
			} catch (e) {
				console.error(`FAIL: Test threw an error: ${e.message}`);
				failed++;
			}
			console.groupEnd();
		});

		console.log(`--- Test Summary ---`);
		console.log(`Passed: ${passed}, Failed: ${failed}`);
		if (failed > 0) {
			console.error("Some tests failed!");
		} else {
			console.log("%cAll tests passed!", "color: green; font-weight: bold;");
		}
		return failed === 0;
	}
	*/
	// [VF-PATCH:CoreDecodeEngine] END

	const MAX_INPUT_SIZE = 10000;

	// set of strings to search for
	function addToFifo(sObj, fifoName) { // TODO: add blacklist arg
		// [VF-PATCH:SizeLimit] START
		let inputSize = 0;
		if (typeof sObj.search === 'string') {
			inputSize = sObj.search.length;
		} else if (typeof sObj.search === 'object' && sObj.search !== null) {
			try {
				inputSize = JSON.stringify(sObj.search).length;
			} catch (e) {
				return; // Cannot serialize, so skip
			}
		}
		if (inputSize > MAX_INPUT_SIZE) {
			return; // Skip oversized input
		}
		// [VF-PATCH:SizeLimit] END

		const fifo = ALLSOURCES[fifoName];
		if (!fifo) {
			throw `No ${fifoName}`;
		}
		// Yield the original value first
		if (!BLACKLIST.matchAny(sObj.search) && !fifo.has(sObj.search)) {
			fifo.nq({...sObj, search: sObj.search, decode: "initial"});
		}

		for (const [search, decode] of CoreDecodeEngine.deepDecode(sObj.search)) {
			if (BLACKLIST.matchAny(search) || fifo.has(search)) {
				continue;
			}
			const throwaway = fifo.nq({...sObj, search: search, decode: decode});

			if (throwaway % rotateWarnAt == 1) {
				rotateWarnAt *= 2;
				const intCol = CONFIG.formats.interesting;
				real.log(`%c[EV INFO]%c '${CONFIG.formats[fifoName].pretty}' fifo limit (${fifo.limit}) exceeded. EV has rotated out ${throwaway} items so far. From url: %c${location.href}`,
					intCol.highlight, intCol.default, intCol.highlight
				);
			}
		}
	}

	/**
	* Helper function to turn parsable arguments into nice strings
	* @arg {Object|string} arg Argument to be turned into a string
	**/
	function argToString(arg) {
		if (typeof(arg) === "string")
			return arg
		if (typeof(arg) === "object")
			return real.JSON.stringify(arg)
		return arg.toString();
	}

	/**
	* Returns the type of an argument. Returns null if the argument should be
	* skipped.
	* @arg arg Argument to have it's type checked
	*/
	function typeCheck(arg) {
		const knownTypes = [
			"function", "string", "number", "object", "undefined", "boolean",
			"symbol"
		];
		const t = typeof(arg);

		// sanity
		if (!knownTypes.includes(t)) {
			throw `Unexpect argument type ${t} for ${arg}`;
		}

		// configured to not check
		if (!CONFIG.types.includes(t)) {
			return null;
		}

		return t;
	}

	/**
	* Turn all arguments into strings and change record original type
	*
	* @args {Object} args `arugments` object of hooked function
	*/
	function getArgs(args) {
		const ret = [];

		if (typeof(arguments[Symbol.iterator]) !== "function") {
			throw "Aguments can't be iterated over."
		}

		for (const i in args) {
			if (!args.hasOwnProperty(i)) continue;
			const t = typeCheck(args[i]);
			if (t === null) continue;
			const ar = {
				"type": t,
				"str": argToString(args[i]),
				"num": +i,
			}
			if (t !== "string") {
				ar["orig"] = args[i];
			}
			ret.push(ar);
		}
		return {"args" : ret, "len" : args.length};
	}

	function printTitle(name, format, num) {
		let titleGrp = "%c[EV] %c%s%c %s"
		let func = real.logGroup;
		const values = [
			format.default, format.highlight, name, format.default, location.href
		];

		if (!format.open) {
			func = real.logGroupCollapsed;
		}
		if (num >1) {
			// add arg number in format
			titleGrp = "%c[EV] %c%s[%d]%c %s"
			values.splice(3,0,num);
		}
		func(titleGrp, ...values)
		return titleGrp;
	}

	/**
	* Print all the arguments to the hooked funciton
	*
	* @argObj {Array} args array of arguments
	**/
	function printArgs(argObj) {
		const argFormat = CONFIG.formats.args;
		if (!argFormat.use) return;
		const func = argFormat.open ? real.logGroup : real.logGroupCollapsed;

		function printFuncAlso(arg) {
			if (arg.type === "function" && arg.orig) {
				real.log(arg.orig);
			}
		}

		if (argObj.len === 1 && argObj.args.length == 1) {
			const arg = argObj.args[0];
			const argTitle ="%carg(%s):";
			const data = [
				argFormat.default,
				arg.type,
			];
			func(argTitle, ...data);
			real.log("%c%s", argFormat.highlight, arg.str);
			printFuncAlso(arg);
			real.logGroupEnd(argTitle);
			return
		}

		const argTitle = "%carg[%d/%d](%s): "
		const total = argObj.len;
		for (const i of argObj.args) {
			func(argTitle, argFormat.default, i.num + 1, total, i.type);
			real.log("%c%s", argFormat.highlight, i.str);
			printFuncAlso(i);
			real.logGroupEnd(argTitle);
		}
	}

	function zebraBuild(arr, fmts) { // fmt2 is used via arguments
		const fmt = "%c%s".repeat(arr.length);
		const args = [];
		for (let i=0; i<arr.length; i++) {
			args.push(fmts[i % 2]);
			args.push(arr[i]);
		}
		args.unshift(fmt);
		return args;
	}

	function zebraLog(arr, fmt) {
		real.log(...zebraBuild(arr, [fmt.default, fmt.highlight]));
	}

	function zebraGroup(arr, fmt) {
		const a = zebraBuild(arr, [fmt.default, fmt.highlight]);
		if (fmt.open) {
			real.logGroup(...a);
		} else {
			real.logGroupCollapsed(...a);
		}
		return a[0];
	}

	/**
	* Check interest and get printers for each interesting result
	*
	* @argObj {Array} args array of arguments
	**/
	function getInterest(argObj, intrBundle) {

		function printer(s, arg) {
			const fmt = CONFIG.formats[s.name];
			const display = s.display? s.display: s.name;
			let word = s.search;
			let dots = "";
			if (word.length > 80) {
				dots = "..."
				word = s.search.substr(0, 77);
			}
			const title = [
				s.param? `${display}[${s.param}]: ` :`${display}: `, word
			];
			if (argObj.len > 1) {
				title.push(`${dots} found (arg:`, arg.num, ")");
			} else {
				title.push(`${dots} found`);
			}
			if (s.decode) {
				title.push(" [Decoded]");
			}

			const end = zebraGroup(title, fmt);
			if (dots) {
				const d = "Entire needle:"
				real.logGroupCollapsed(d);
				real.log(s.search);
				real.logGroupEnd(d);
			}
			if (s.decode) { // TODO probably should be moved to the recursve decoder area
				const d = "Encoder function:";
				real.logGroupCollapsed(d);
				let add = "\t";
				let pmtwo = false;
				switch (s.name) { // TODO: this should be moved to interestBundle, I think
				case "path":
					if (!s.param) break;
					add += `if (y) {\n\t\t`
					add += `const pth = document.location.pathname.substring(1).split('/');\n\t\t`;
					add += `pth[${s.param}] = x;\n\t\t`;
					add += `document.location.pathname = '/' + pth.join('/');\n\t`;
					add += `}\n\t`
					pmtwo = true;
					break;
				case "localStore":
					if (!s.param) break;
					add += `if (y) localStorage.setItem("${s.param}", x);\n\t`;
					pmtwo = true;
					break;
				case "query":
					if (!s.param) break;
					add +=  `const _ = new URL(window.location.href);\n\t`
					add += `// next line might need some changes\n\t`;
					add += `_.searchParams.set('${s.param.replaceAll('"', '\x22')}', decodeURIComponent(x));\n\t`;
					add += `x = _.href;\n\t`;
					add += `if (y) window.location = x;\n\t`
					pmtwo = true;
					break;
				case "winname":
					add +=  `if (y) window.name = x;\n\t`
					pmtwo = true;
					break;
				}

				real.log(`encoder = ${pmtwo ? "(x, y)" : "x"} => {\n${s.decode}${add}return x;\n}//`);
				real.logGroupEnd(d);
			}
			zebraLog(s.split, fmt);
			real.logGroupEnd(end);
		}

		// update changing lists
		addChangingSearch();

		const ret = [];

		for (const arg of argObj.args) {
			for (const match of intrBundle.genSplits(arg.str)) {
				ret.push(() => printer(match, arg));
			}
		}

		return ret;
	}

	/**
	* Parse all arguments for function `name` and pretty print them in the console
	* @param {SearchBundle}	intrBundle Used to check if a call is interesting
	* @param {string}	name Name of function that is being hooked
	* @param {array}	args array of arguments
	* @returns {boolean} Always returns `false`
	**/
	function EvalVillainHook(intrBundle, name, args) {
		const fmts = CONFIG.formats;
		let argObj = {};
		try {
			argObj = getArgs(args);
		} catch(err) {
			real.log("%c[ERROR]%c EV args error: %c%s%c on %c%s%c",
				fmts.interesting.default,
				fmts.interesting.highlight,
				fmts.interesting.default, err, fmts.interesting.highlight,
				fmts.interesting.default, document.location.href, fmts.interesting.highlight
			);
			return false;
		}

		if (argObj.args.length == 0) {
			return false;
		}

		// does this call have an interesting result?
		let format = null;
		const printers = getInterest(argObj, intrBundle);

		if (printers.length > 0) {
			format = fmts.interesting;
			if (!format.use) {
				return false;
			}
		} else {
			format = fmts.title;
			if (!format.use) {
				return false;
			}
		}

		const titleGrp = printTitle(name, format, argObj.len);
		printArgs(argObj);

		// print all intereresting reuslts
		printers.forEach(x=>x());

		// stack display
		// don't put this into a function, it will be one more thing on the call
		// stack
		const stackFormat = CONFIG.formats.stack;
		if (stackFormat.use) {
			const stackTitle = "%cstack: "
			if (stackFormat.open) {
				real.logGroup(stackTitle, stackFormat.default);
			} else {
				real.logGroupCollapsed(stackTitle, stackFormat.default);
			}
			real.trace();
			real.logGroupEnd(stackTitle);
		}
		real.logGroupEnd(titleGrp);
		return false;
	}

	class evProxy {
		constructor(intr) {
			self.intr = intr;
		}

		// Start of Eval Villain hook
		apply(_target, _thisArg, args) {
			EvalVillainHook(self.intr, this.evname, args);
			return Reflect.apply(...arguments);
		}

		// Start of Eval Villain hook
		construct(_target, args, _newArg) {
			EvalVillainHook(self.intr, this.evname, args);
			return Reflect.construct(...arguments);
		}
	}

	/*
	 * NOTICE:
	 * updates here should maybe be reflected in input validation
	 * file: /pages/config/config.js
	 * function: validateFunctionsPattern
	*/
	/**
	 * Accepts sink name, such as `document.write` or `value(URLSearchParams.get)` and replaces the sink with a proxy (`evProxy`).
	 * @param {string} evname	Name of sink to hook.
	 **/
	function applyEvalVillain(evname) {
		function getFunc(n) {
			const ret = {}
			ret.where = window;
			const groups = n.split(".");
			let i = 0; // outside for loop for a reason
			for (i=0; i<groups.length-1; i++) {
				ret.where = ret.where[groups[i]];
				if (!ret.where) {
					return null;
				}
			}
			ret.leaf = groups[i];
			return ret ? ret : null;
		}

		const ownprop = /^(set|value)\(([a-zA-Z.]+)\)\s*$/.exec(evname);
		const ep = new evProxy(INTRBUNDLE);
		ep.evname = evname;
		if (ownprop) {
			const prop = ownprop[1];
			const f = getFunc(ownprop[2]);
			const orig = Object.getOwnPropertyDescriptor(f.where.prototype, f.leaf)[prop];
			Object.defineProperty(f.where.prototype, f.leaf, {[prop] : new Proxy(orig, ep)});
		} else if (!/^[a-zA-Z.]+$/.test(evname)) {
			real.log("[EV] name: %s invalid, not hooking", evname);
		} else {
			const f = getFunc(evname);
			f.where[f.leaf] = new Proxy(f.where[f.leaf], ep);
		}
	}

	/**
	 * Some sources can change without reloading the page, so EV checks for
	 * them every time. This is should be relativly fast. If they are seen
	 * before, they should not go through deep decoding loop.
	 */
	function addChangingSearch() {
		// window.name
		if (ALLSOURCES.winname) {
			addToFifo({
				display: "window.name",
				search: window.name,
			}, "winname");
		}

		if (ALLSOURCES.fragment) {
			addToFifo({
				search: location.hash.substring(1),
			}, "fragment");
		}

		if (ALLSOURCES.query) {
			const srch = window.location.search;
			if (srch.length > 1) {
				for (const [key, value] of getAllQueryParams(srch)) {
					addToFifo({
						param: key,
						search: value
					}, "query");
				}
			}
		}

		if (ALLSOURCES.path) {
			const pth = location.pathname;
			if (pth.length >= 1) {
				addToFifo({search: pth}, "path");
				pth.substring(1)
					.split('/').forEach((elm, index) => {
						addToFifo({
							param: ""+index,
							search: elm
						}, "path");
				});
			}
		}
	}


	/**
	 * Parses initial values contained in sources and updates fifos with them.
	 **/
	function buildSearches() {
		const {formats} = CONFIG;

		function putInUse(nm) {
			if (formats[nm] && formats[nm].use) {
				ALLSOURCES[nm] = new SourceFifo(formats[nm].limit);
				return true;
			}
			return false;
		}

		// referer
		let nm = "referrer";
		if (putInUse(nm) && document.referrer) {
			const url = new URL(document.referrer);
			// don't show if referer is just https://example.com/ and we are on an example.com domain
			if (url.search != location.search || url.search && url.pathname !== "/" && url.hostname !== location.hostname) {
				addToFifo({
					search: document.referrer
				}, nm);
			}
		}

		// cookies
		nm = "cookie";
		if (putInUse(nm)) {
			for (const i of document.cookie.split(/;\s*/)) {
				const s = i.split("=");
				if (s.length >= 2) {
					addToFifo({
						param: s[0],
						search: s[1],
					}, nm);
				} else {
					addToFifo({
						search: s[0],
					}, nm);
				}
			}
		}

		nm = "localStore"
		if (putInUse(nm)){
			const l = real.localStorage.length;
			for (let i=0; i<l; i++) {
				const key = real.localStorage.key(i);
				addToFifo({
					display: "localStorage",
					param: key,
					search: real.localStorage.getItem(key),
				}, nm);
			}
		}


		// TODO seems repeated
		putInUse("winname")
		putInUse("fragment");
		putInUse("path");
		putInUse("query");
		addChangingSearch();
	}

	// prove we loaded
	if (CONFIG.checkId) {
		document.currentScript.setAttribute(CONFIG.checkId, true);
		delete CONFIG["checkId"];
	}

	// grab real functions before hooking
	const real = {
		log : console.log,
		debug : console.debug,
		warn : console.warn,
		dir : console.dir,
		error : console.error,
		logGroup : console.group,
		logGroupEnd : console.groupEnd,
		logGroupCollapsed : console.groupCollapsed,
		trace : console.trace,
		JSON : JSON,
		localStorage: localStorage,
		decodeURIComponent : decodeURIComponent,
		decodeURI : decodeURI,
		atob: atob,
	}

	const BLACKLIST = new NeedleBundle(CONFIG.blacklist);
	delete CONFIG.blacklist;
	const INTRBUNDLE = new SearchBundle(
		new NeedleBundle(CONFIG.needles),
		ALLSOURCES
	);
	delete CONFIG.needles;

	buildSearches();

	for (const nm of CONFIG["functions"]) {
		applyEvalVillain(nm);
	}

	// turns console.log into console.info
	if (CONFIG.formats.logReroute.use) {
		console.log = console.info;
	}

	if (CONFIG.sinker) {
		window[CONFIG.sinker] = (x,y) => EvalVillainHook(INTRBUNDLE, x, y);
		delete CONFIG.sinker;
	}

	if (CONFIG.sourcer) {
		const fmt = CONFIG.formats.userSource;
		if (fmt.use) {
			const srcer = CONFIG.sourcer;
			ALLSOURCES.userSource = new SourceFifo(fmt.limit);
			window[srcer] = (src_name, src_val, debug=false) => {
				// ex: evSourcer("Response from fetch", resp.json(), true)
				// debug=true results in a console.debug for each source injested
				if (debug) {
					const o = typeof(src_val) === 'string'? src_val: real.JSON.stringify(src_val);
					real.debug(`[EV] ${srcer}[${src_name}] from ${document.location.origin}  added:\n ${o}`);
				}
				addToFifo({
					display: `${srcer}[${src_name}]`,
					search: src_val,
					}, "userSource");
				return false;
			}
			delete CONFIG.sourcer;
		}
	}

	real.log("%c[EV]%c Functions hooked for %c%s%c",
		CONFIG.formats.interesting.highlight,
		CONFIG.formats.interesting.default,
		CONFIG.formats.interesting.highlight,
		document.location.origin,
		CONFIG.formats.interesting.default
	);

	// [VF-PATCH:PassiveInputListener] START
	function setupPassiveInputListener() {
		const targetNode = document.body;
		if (!targetNode) {
			// In some environments (like when running in a worker), body may not be available.
			return;
		}

		const observerConfig = { childList: true, subtree: true };
		const SELECTORS = 'input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="password"], textarea, [contenteditable="true"]';

		// Function to find all target elements in a node's light and shadow DOMs
		const addListenersToNode = (node) => {
			if (node.nodeType !== Node.ELEMENT_NODE) return;

			const elementsToProcess = new Set();

			// Find elements in the node's light DOM
			node.querySelectorAll(SELECTORS).forEach(el => elementsToProcess.add(el));

			// Find elements in the shadow DOM of the node itself and all its descendants
			const allNodes = [node, ...node.querySelectorAll('*')];
			allNodes.forEach(el => {
				if (el.shadowRoot) {
					el.shadowRoot.querySelectorAll(SELECTORS).forEach(shadowEl => elementsToProcess.add(shadowEl));
				}
			});

			elementsToProcess.forEach(el => attachListeners(el));
		};

		const mutationCallback = (mutationsList) => {
			for (const mutation of mutationsList) {
				if (mutation.type === 'childList') {
					mutation.addedNodes.forEach(node => addListenersToNode(node));
				}
			}
		};

		const observer = new MutationObserver(mutationCallback);
		addListenersToNode(targetNode);
		observer.observe(targetNode, observerConfig);

		const lastValueMap = new WeakMap();
		const debounceMap = new WeakMap();

		function attachListeners(element) {
			if (element.dataset.evListenersAttached) return;
			real.log(`[EV-DEBUG] Attaching listeners to:`, element);
			element.addEventListener('input', eventHandler);
			element.addEventListener('change', eventHandler);
			element.addEventListener('keyup', eventHandler);
			element.dataset.evListenersAttached = true;
		}

		function eventHandler(event) {
			real.log(`[EV-DEBUG] Event triggered: ${event.type}`, event.target);
			const element = event.target;
			const value = element.isContentEditable ? element.textContent : element.value;

			// Duplicate prevention
			if (lastValueMap.get(element) === value) {
				real.log(`[EV-DEBUG] Duplicate value skipped: "${value}"`);
				return;
			}
			lastValueMap.set(element, value);

			// [VF-PATCH:PassiveInputDebounce] START
			if (debounceMap.has(element)) {
				clearTimeout(debounceMap.get(element));
			}
			real.log(`[EV-DEBUG] Setting debounce timer for value: "${value}"`);
			const timeoutId = setTimeout(() => {
				processValue(element, value);
			}, 250);
			debounceMap.set(element, timeoutId);
			// [VF-PATCH:PassiveInputDebounce] END
		}

		function processValue(element, value) {
			real.log(`[EV-DEBUG] Processing value: "${value}"`, element);
			// [VF-PATCH:PassiveInputSizeLimit] START
			const MAX_PASSIVE_INPUT_SIZE = 10000;
			if (value.length > MAX_PASSIVE_INPUT_SIZE) {
				real.log(`[EV-DEBUG] Value skipped due to size limit.`);
				return; // Skip oversized input
			}
			// [VF-PATCH:PassiveInputSizeLimit] END

			const sObj = {
				search: value,
				timestamp: new Date().toISOString(),
				origin: location.origin,
				display: element.tagName.toLowerCase() + (element.id ? `#${element.id}` : '')
			};

			real.log(`[EV-DEBUG] Calling addToFifo with:`, sObj);
			addToFifo(sObj, 'userSource');
		}
	}
	setupPassiveInputListener();
	// [VF-PATCH:PassiveInputListener] END
}
