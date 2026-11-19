import {
  BookOpen,
  Code2,
  FileText,
  Globe,
  ListChecks,
  ListTodo,
  MapPin,
  MessageCircleQuestion,
  Search,
} from "lucide-react";

const ICONS = {
  run_python: Code2,
  read_webpage: Globe,
  create_action_plan: ListTodo,
  update_action_plan: ListChecks,
  ask_user: MessageCircleQuestion,
  search_wikipedia: BookOpen,
  get_current_context: MapPin,
  create_research_paper: FileText,
  mcp: Search,
} as const;

export function ToolIcon({ name, size = 15 }: { name: string; size?: number }) {
  const Icon = ICONS[name as keyof typeof ICONS] ?? Search;
  return <Icon size={size} aria-hidden className="tool-icon" />;
}
