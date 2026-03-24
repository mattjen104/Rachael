export interface CaptureTemplate {
  key: string;
  label: string;
  prefix: string;
  autoTags: string[];
  expectsImage: boolean;
  description: string;
}

export const CAPTURE_TEMPLATES: CaptureTemplate[] = [
  {
    key: "t",
    label: "Task",
    prefix: "t ",
    autoTags: [],
    expectsImage: false,
    description: "Create a TODO task",
  },
  {
    key: "n",
    label: "Note",
    prefix: "",
    autoTags: [],
    expectsImage: false,
    description: "Create a plain note",
  },
  {
    key: "j",
    label: "Journal",
    prefix: "",
    autoTags: ["journal"],
    expectsImage: false,
    description: "Daily journal entry with today's date",
  },
  {
    key: "s",
    label: "Screenshot",
    prefix: "",
    autoTags: ["screenshot"],
    expectsImage: true,
    description: "Capture with screenshot attachment",
  },
  {
    key: "b",
    label: "Bookmark",
    prefix: "",
    autoTags: ["bookmark"],
    expectsImage: false,
    description: "Save a URL bookmark",
  },
  {
    key: "m",
    label: "Meeting",
    prefix: "",
    autoTags: ["meeting"],
    expectsImage: false,
    description: "Meeting notes with date",
  },
];
