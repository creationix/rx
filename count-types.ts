const path = process.argv[2] ?? "large-sample.json"

const counts = {
	string: 0,
	number: 0,
	boolean: 0,
	null: 0,
	object: 0,
	array: 0,
}

function walk(value: unknown) {
	if (value === null) {
		counts.null++
	} else if (Array.isArray(value)) {
		counts.array++
		for (const v of value) walk(v)
	} else if (typeof value === "object") {
		counts.object++
		for (const v of Object.values(value as Record<string, unknown>)) walk(v)
	} else if (typeof value === "string") {
		counts.string++
	} else if (typeof value === "number") {
		counts.number++
	} else if (typeof value === "boolean") {
		counts.boolean++
	}
}

const raw = await Bun.file(path).text()
walk(JSON.parse(raw))

console.log(counts)
