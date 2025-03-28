#!/usr/bin/env node

// Usage:
//
// First collect trace2 event data from a Git command:
//
//  GIT_TRACE2_EVENT="$(pwd)/trace.txt" GIT_TRACE2_EVENT_DEPTH=100 \
//    git <options>
//
// Then, feed the trace file into the trace2-flamegraph tool, with
// the output redirected to a *.svg file:
//
//   trace2-flamegraph <trace.txt >flamegraph.svg
//
// Open the *.svg file in the browser or your favorite editor, such
// as Inkscape.

var readline = require('readline');

var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });

let events = new Set();
events.add("region_enter");
events.add("region_leave");
events.add("start");
events.add("exit");

const line_objs = [];
let active = true;
let nesting = 0;
let first_pass_stack = [];

rl.on('line', function(line) {
        if (!active) {
                return;
        }

        let obj = JSON.parse(line);
        if (events.has(obj.event)) {
                obj.ms_time = Date.parse(obj.time);
                line_objs.push(obj);

                if (obj.event == "start" || obj.event == "region_enter") {
                        first_pass_stack.push(obj);
                        nesting = Math.max(nesting, first_pass_stack.length);
                }
        }
});

rl.on('close', function() {
        const start = line_objs[0].ms_time;
        const end = line_objs[line_objs.length - 1].ms_time;
        const total_time = end - start;

        let unit = "ms";
        let unit_divisor = 1;
        let interval = 100;
        let width_divisor = 1;

        if (total_time > 10000) {
                unit = "s";
                unit_divisor = 1000;
                interval = 5000;
                width_divisor = 50;
        } else if (total_time > 2500) {
                unit = "s";
                unit_divisor = 1000;
                interval = 1000;
                width_divisor = 10;
        }

        const rectangles = [];

        let depth = 0;
        let max_depth = 0;
        const width = total_time / width_divisor;

        let stack = [];
        let last_at_depth = {};

        for (let i = 0; i < line_objs.length; i++) {
                let obj = line_objs[i];

                if (obj.event == "start") {
                        // Skip over long-lived branches
                        if (!obj.argv[0].includes("gvfs-helper") &&
                            (obj.argv.length < 2 || !obj.argv[1].includes("gvfs-helper"))) {
                                depth++;
                        }
                        stack.push(obj);
                        continue;
                }

                if (obj.event == "region_enter") {
                        stack.push(obj);
                        depth++;
                        continue;
                }

                if (obj.event == "region_leave" || obj.event == "exit") {
                        let top = stack.pop();

                        if (top.event == "start" &&
                            (top.argv[0].includes("gvfs-helper") ||
                               (top.argv.length > 1 && top.argv[1].includes("gvfs-helper")))) {
                                continue;
                        }

                        if (obj.event == "region_leave") {
                                obj.row_label = obj.category + ":" + obj.label;
                        } else if (top.event == "start") {
                                obj.row_label = top.argv.join(' ');
                        } else {
                                // Mismatched, so skip over this one.
                                // Likely due to a long-lived child.
                                continue;
                        }

                        depth--;

                        let region_start = top.ms_time;
                        let region_end = obj.ms_time;

                        let w = width * (region_end - region_start) / total_time;

                        let rect = {
                                "label": obj.row_label,
                                "start": region_start,
                                "end": region_end,
                                "depth": depth,
                                "multiple": 1,
                        };

                        max_depth = Math.max(depth, max_depth);

                        if (last_at_depth[depth] != null) {
                                let last = last_at_depth[depth];
                                if (last.label != rect.label) {
                                        rectangles.push(last);
                                } else {
                                        rect.width = rect.width + rect.x - last.x;
                                        rect.x = last.x;
                                        rect.multiple = last.multiple + 1;
                                }
                        }

                        last_at_depth[depth] = rect;
                }
        }

        for (const [key, value] of Object.entries(last_at_depth)) {
                rectangles.push(value);
        }

        const row_height = 50;
        const height = 70 + row_height * (max_depth + 1);
        console.log("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + width + "\" height=\"" + height + "\">");

        console.log("<style>");
        console.log(".box { font: 16px sans-serif; }");
        console.log(".axis { font: 12px sans-serif; }");
        console.log("</style>");

        for (let i = 0; i < total_time; i+= interval) {
                console.log("<line x1=\"" + (i / width_divisor) + "\" y1=\"0\" x2=\"" + (i / width_divisor) + "\" y2=\"" + height + "\" style=\"stroke-width:1; stroke:black;\" />");
                console.log("<text class=\"axis\" x=\"" + ((i / width_divisor) + 3) + "\" y=\"10\">" + (i / unit_divisor) + unit + "</text>");
        }

        for (let i = 0; i < rectangles.length; i++) {
                let rect = rectangles[i];

                if (rect.multiple > 1) {
                        rect.label = rect.label + " (" + rect.multiple + ")";
                }

                let w = width * (rect.end - rect.start) / total_time;

                if (w < 10) {
                        continue;
                }

                let x = width * (rect.start - start) / total_time;
                let y = height - 10 - (row_height * (rect.depth + 1));

                let fillShade = 150 + 100 * (rect.depth / max_depth);
                let borderShade = 100 * (rect.depth / max_depth);
                let fillColor = "rgb(" + fillShade + "," + (fillShade / 3) + "," + (fillShade / 3) + ")";
                let borderColor = "rgb(" + borderShade + "," + borderShade + "," + borderShade + ")";

                let style = "fill:" + fillColor + ";stroke-width:3;stroke:" + borderColor;

                console.log("<rect width=\"" + w + "\" height=\"" + row_height + "\" x=\"" + x + "\" y=\"" + y + "\" style=\"" + style + "\" />");
                console.log("<text class=\"box\" x=\"" + (x + 5) + "\" y=\"" + (y + 0.8 * row_height) + "\">" + rect.label + "</text>");
        }

        console.log("</svg>");
});
