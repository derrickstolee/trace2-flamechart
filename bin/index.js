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
events.add("child_start");
events.add("child_exit");

const line_objs = [];
let active = true;

function parseWallClockTime(time) {
        let match = /^(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(time);
        if (!match) {
                return NaN;
        }

        let [, hours, minutes, seconds, fraction] = match;
        let millis = 1000 * (3600 * Number(hours) + 60 * Number(minutes) + Number(seconds));

        if (fraction) {
                millis += Number(("0." + fraction)) * 1000;
        }

        return millis;
}

function parsePipeLine(line) {
        let parts = line.split('|').map(part => part.trim());
        if (parts.length < 4) {
                return null;
        }

        let [time] = parts[0].split(/\s+/);
        let obj = {
                "time": time,
                "ms_time": parseWallClockTime(time),
                "sid": parts[1],
                "thread": parts[2],
                "event": parts[3],
                "nesting": Number((parts[4] || '').replace(/^r/, '')),
                "category": parts[7] || '',
                "detail": parts.slice(8).join('|').trim(),
        };

        let child = /\[ch(\d+)\]/.exec(obj.detail);
        if (child) {
                obj.child_id = Number(child[1]);
        }

        let label = /(?:^|\.+)label:(.*)$/.exec(obj.detail);
        if (label) {
                obj.label = label[1];
        }

        let argv = /argv:\[(.*)\]$/.exec(obj.detail);
        if (argv) {
                obj.argv = [argv[1]];
        } else if (obj.event == "start" && obj.detail) {
                obj.argv = [obj.detail];
        }

        return obj;
}

function parseLine(line) {
        if (line[0] == '{') {
                let obj = JSON.parse(line);
                obj.ms_time = Date.parse(obj.time);
                return obj;
        }

        return parsePipeLine(line);
}

function processDepth(sid) {
        if (!sid) {
                return 0;
        }

        if (/^d\d+$/.test(sid)) {
                return Number(sid.substring(1));
        }

        return sid.split('/').length - 1;
}

function keyFor(obj) {
        return (obj.sid || '') + '|' + (obj.thread || '');
}

function childKeyFor(obj) {
        return keyFor(obj) + '|' + (obj.child_id == null ? '' : obj.child_id);
}

function argvLabel(obj) {
        if (!obj.argv) {
                return obj.detail || obj.event;
        }

        return Array.isArray(obj.argv) ? obj.argv.join(' ') : obj.argv;
}

function regionLabel(obj) {
        if (obj.category && obj.label) {
                return obj.category + ":" + obj.label;
        }

        return obj.label || obj.category || obj.event;
}

function isSkippedProcess(obj) {
        let label = argvLabel(obj);
        return label.includes("gvfs-helper");
}

function escapeXml(value) {
        return String(value)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&apos;");
}

rl.on('line', function(line) {
        if (!active) {
                return;
        }

        line = line.trim();
        if (!line) {
                return;
        }

        let obj = parseLine(line);
        if (obj && events.has(obj.event) && !Number.isNaN(obj.ms_time)) {
                line_objs.push(obj);
        }
});

rl.on('close', function() {
        if (!line_objs.length) {
                console.error("No supported trace2 events found.");
                process.exitCode = 1;
                return;
        }

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

        let max_depth = 0;
        const width = total_time / width_divisor;

        let process_starts = {};
        let region_stacks = {};
        let child_starts = {};
        let last_at_depth = {};

        function addRectangle(rect) {
                if (rect.end <= rect.start) {
                        return;
                }

                let last = last_at_depth[rect.depth];
                if (last &&
                    last.label == rect.label &&
                    last.is_child == rect.is_child &&
                    Math.abs(last.end - rect.start) < 0.001) {
                        last.end = rect.end;
                        last.multiple++;
                        return;
                }

                rectangles.push(rect);
                last_at_depth[rect.depth] = rect;
                max_depth = Math.max(rect.depth, max_depth);
        }

        for (let i = 0; i < line_objs.length; i++) {
                let obj = line_objs[i];
                let key = keyFor(obj);

                if (obj.event == "start") {
                        process_starts[obj.sid || key] = obj;
                        continue;
                }

                if (obj.event == "region_enter") {
                        let stack = region_stacks[key];
                        if (!stack) {
                                stack = [];
                                region_stacks[key] = stack;
                        }

                        obj.depth = processDepth(obj.sid) + (obj.nesting || stack.length + 1);
                        stack.push(obj);
                        continue;
                }

                if (obj.event == "child_start") {
                        let stack = region_stacks[key] || [];
                        obj.depth = processDepth(obj.sid) + stack.length + 1;
                        child_starts[childKeyFor(obj)] = obj;
                        continue;
                }

                if (obj.event == "region_leave") {
                        let stack = region_stacks[key];
                        if (!stack || !stack.length) {
                                continue;
                        }

                        let top = stack.pop();
                        addRectangle({
                                "label": regionLabel(obj),
                                "start": top.ms_time,
                                "end": obj.ms_time,
                                "depth": top.depth,
                                "multiple": 1,
                                "is_child": false,
                        });

                        continue;
                }

                if (obj.event == "child_exit") {
                        let top = child_starts[childKeyFor(obj)];
                        if (!top) {
                                continue;
                        }

                        delete child_starts[childKeyFor(obj)];
                        addRectangle({
                                "label": argvLabel(top),
                                "start": top.ms_time,
                                "end": obj.ms_time,
                                "depth": top.depth,
                                "multiple": 1,
                                "is_child": true,
                        });

                        continue;
                }

                if (obj.event == "exit") {
                        let top = process_starts[obj.sid || key];
                        if (!top || isSkippedProcess(top)) {
                                continue;
                        }

                        addRectangle({
                                "label": argvLabel(top),
                                "start": top.ms_time,
                                "end": obj.ms_time,
                                "depth": processDepth(top.sid),
                                "multiple": 1,
                                "is_child": false,
                        });
                }
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

                let depthRatio = max_depth ? rect.depth / max_depth : 0;
                let fillShade = 150 + 100 * depthRatio;
                let borderShade = 100 * depthRatio;
                let fillColor, borderColor;
                if (rect.is_child) {
                        fillColor = "rgb(" + (fillShade / 3) + "," + (fillShade / 3) + "," + fillShade + ")";
                        borderColor = "rgb(" + borderShade + "," + borderShade + "," + borderShade + ")";
                } else {
                        fillColor = "rgb(" + fillShade + "," + (fillShade / 3) + "," + (fillShade / 3) + ")";
                        borderColor = "rgb(" + borderShade + "," + borderShade + "," + borderShade + ")";
                }

                let style = "fill:" + fillColor + ";stroke-width:3;stroke:" + borderColor;

                console.log("<rect width=\"" + w + "\" height=\"" + row_height + "\" x=\"" + x + "\" y=\"" + y + "\" style=\"" + style + "\" />");
                console.log("<text class=\"box\" x=\"" + (x + 5) + "\" y=\"" + (y + 0.8 * row_height) + "\">" + escapeXml(rect.label) + "</text>");
        }

        console.log("</svg>");
});
