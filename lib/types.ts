export type StepStatus = "completed" | "in_progress" | "waiting" | "error";

export interface PipelineStep {
  id: number;
  name: string;
  tool: string;
  icon: string;
  description: string;
  costEstimate: string;
  status: StepStatus;
  progress: number;
}

export interface VideoProject {
  id: string;
  title: string;
  niche: string;
  createdAt: string;
  steps: Record<number, StepStatus>;
  totalCost: number;
}

export interface BudgetItem {
  poste: string;
  outil: string;
  volume: string;
  coutMois: string;
  amount: number;
}

export interface Scenario {
  name: string;
  label: string;
  totalMin: number;
  totalMax: number;
  costPerVideo: string;
  items: BudgetItem[];
}

export interface PricingComparison {
  modele: string;
  prixFalai: string;
  prixOfficiel: string;
  economie: string;
}
