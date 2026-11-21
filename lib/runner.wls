(* ===========================================================================
   DSH wolfram executor — invoked as:  wolfram.exe -noprompt -script runner.wls
   Sibling files, all created per call by lib/executor.js:
     code.wl      UTF-8 (no BOM), exactly one Wolfram Language expression
     timeout.txt  seconds, ASCII integer
   The result travels on STDOUT as one line prefixed with RESULT_MARKER: a
   confined kernel may be forbidden to write anywhere, but it can always write
   to the handles it inherited.
   Verified on Wolfram Engine 15.0.0 (Windows x64).
   =========================================================================== *)

dir = DirectoryName[$InputFileName];
codeFile = FileNameJoin[{dir, "code.wl"}];
resultMarker = "@@DSH-WOLFRAM-RESULT@@";



timeoutSec = ToExpression @ StringTrim @ Import[
  FileNameJoin[{dir, "timeout.txt"}], "Text", CharacterEncoding -> "UTF-8"];

(* Import with an explicit character encoding: on a localized Windows install the
   system ANSI code page silently mangles non-ASCII source otherwise. *)
text = Import[codeFile, "Text", CharacterEncoding -> "UTF-8"];
(* Capture the parser's own messages: without them a syntax error reaches the
   model as a bare "syntax error" and it must guess what broke. *)
parseMessages = {};
held = Block[{$MessageList = {}},
  Module[{h},
    h = ToExpression[text, InputForm, Hold];
    parseMessages = ToString /@ $MessageList;
    h
  ]
];

status = "ok";
res = Null;
messages = parseMessages;
elapsed = 0.;

If[held === $Failed,
  status = "syntax",
  t0 = AbsoluteTime[];
  res = Block[{$MessageList = {}},
    Module[{r},
      r = TimeConstrained[ReleaseHold[held], timeoutSec, (status = "timeout"; $TimedOut)];
      messages = Join[parseMessages, ToString /@ $MessageList];
      r
    ]
  ];
  elapsed = AbsoluteTime[] - t0;
  If[status === "ok" && res === $Failed, status = "failed"];
];

(* Only `ok` and `failed` carry a value worth showing: a syntax error leaves
   `res` as the placeholder Null, and a timeout leaves $TimedOut, neither of
   which is a result. Exporting them would read as a real answer. *)
hasValue = MemberQ[{"ok", "failed"}, status];

(* Export integer milliseconds, never the raw real: Wolfram's JSON writer emits
   small machine reals as e.g. `0.e-7`, which is valid WL but invalid JSON, so a
   fast evaluation would produce an unreadable envelope. *)
elapsedMs = Round[elapsed*1000];

envelope = <|
  "status" -> status,
  "inputForm" -> If[hasValue, ToString[res, InputForm], ""],
  "tex" -> If[status === "ok", ToString[res, TeXForm], ""],
  "messages" -> messages,
  "elapsedMs" -> elapsedMs
|>;

(* ExportString hands back the JSON text as raw UTF-8 bytes, one byte per
   character; decode them back to text before anything else touches them. *)
core = ExportString[envelope, "JSON"];
codes = ToCharacterCode[core];
json = If[Length[codes] > 0 && Max[codes] < 256, FromCharacterCode[codes, "UTF-8"], core];

(* Newlines are collapsed so the envelope stays on one line the plugin can find.
   JSON escapes real newlines inside strings, so this cannot corrupt a value. *)
json = StringReplace[json, {"\r" -> " ", "\n" -> " ", "\t" -> " "}];

(* Keep the line pure ASCII. The console stream is re-encoded on its way out, so a
   raw non-ASCII byte arrives mangled; JSON \uXXXX escapes are exactly equivalent
   and survive any code page. WriteString, not Print: Print renders a string in
   its quoted form and would escape every quote in the envelope. *)
asciiJson = StringReplace[json,
  c_ /; ToCharacterCode[c][[1]] > 127 :> "\\u" <> IntegerString[ToCharacterCode[c][[1]], 16, 4]];

WriteString[$Output, resultMarker, asciiJson, "\n"];

