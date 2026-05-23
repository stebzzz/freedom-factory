"use client";

import React, { useState } from "react";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDotDashed,
  CircleX,
} from "lucide-react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";

interface Subtask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  tools?: string[];
}

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  level: number;
  dependencies: string[];
  subtasks: Subtask[];
}

interface PlanProps {
  tasks: Task[];
  defaultExpanded?: string[];
}

export default function Plan({ tasks: initialTasks, defaultExpanded = [] }: PlanProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [expandedTasks, setExpandedTasks] = useState<string[]>(defaultExpanded);
  const [expandedSubtasks, setExpandedSubtasks] = useState<Record<string, boolean>>({});

  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  const toggleTaskExpansion = (taskId: string) => {
    setExpandedTasks((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  };

  const toggleSubtaskExpansion = (taskId: string, subtaskId: string) => {
    const key = `${taskId}-${subtaskId}`;
    setExpandedSubtasks((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleSubtaskStatus = (taskId: string, subtaskId: string) => {
    setTasks((prev) =>
      prev.map((task) => {
        if (task.id === taskId) {
          const updatedSubtasks = task.subtasks.map((subtask) => {
            if (subtask.id === subtaskId) {
              return { ...subtask, status: subtask.status === "completed" ? "pending" : "completed" };
            }
            return subtask;
          });
          const allDone = updatedSubtasks.every((s) => s.status === "completed");
          return { ...task, subtasks: updatedSubtasks, status: allDone ? "completed" : task.status };
        }
        return task;
      })
    );
  };

  const taskVariants = {
    hidden: { opacity: 0, y: -5 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { type: "spring" as const, stiffness: 500, damping: 30 },
    },
  };

  const subtaskListVariants = {
    hidden: { opacity: 0, height: 0 },
    visible: {
      height: "auto",
      opacity: 1,
      transition: { duration: 0.25, staggerChildren: 0.05, when: "beforeChildren" as const },
    },
    exit: { height: 0, opacity: 0, transition: { duration: 0.2 } },
  };

  const subtaskVariants = {
    hidden: { opacity: 0, x: -10 },
    visible: {
      opacity: 1,
      x: 0,
      transition: { type: "spring" as const, stiffness: 500, damping: 25 },
    },
  };

  const subtaskDetailsVariants = {
    hidden: { opacity: 0, height: 0 },
    visible: { opacity: 1, height: "auto", transition: { duration: 0.25 } },
  };

  return (
    <motion.div
      className="rounded-xl border overflow-hidden"
      style={{ background: "var(--bg-glass)", borderColor: "var(--border-glass)", backdropFilter: "blur(20px)" }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.3 } }}
    >
      <LayoutGroup>
        <div className="p-4 overflow-hidden">
          <ul className="space-y-1 overflow-hidden">
            {tasks.map((task, index) => {
              const isExpanded = expandedTasks.includes(task.id);
              const isCompleted = task.status === "completed";

              return (
                <motion.li key={task.id} className={index !== 0 ? "mt-1 pt-2" : ""} initial="hidden" animate="visible" variants={taskVariants}>
                  <motion.div
                    className="group flex items-center px-3 py-1.5 rounded-lg cursor-pointer"
                    whileHover={{ backgroundColor: "var(--bg-glass-hover)" }}
                    onClick={() => toggleTaskExpansion(task.id)}
                  >
                    <div className="mr-2.5 flex-shrink-0">
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={task.status}
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          transition={{ duration: 0.2 }}
                        >
                          {task.status === "completed" ? (
                            <CheckCircle2 className="h-[18px] w-[18px] text-emerald-400" />
                          ) : task.status === "in-progress" ? (
                            <CircleDotDashed className="h-[18px] w-[18px] text-blue-400" />
                          ) : task.status === "need-help" ? (
                            <CircleAlert className="h-[18px] w-[18px] text-amber-400" />
                          ) : task.status === "failed" ? (
                            <CircleX className="h-[18px] w-[18px] text-red-400" />
                          ) : (
                            <Circle className="h-[18px] w-[18px]" style={{ color: "var(--text-tertiary)" }} />
                          )}
                        </motion.div>
                      </AnimatePresence>
                    </div>

                    <div className="flex min-w-0 flex-grow items-center justify-between">
                      <span className={`text-[14px] font-medium truncate ${isCompleted ? "line-through opacity-50" : ""}`} style={{ color: "var(--text-primary)" }}>
                        {task.title}
                      </span>

                      <div className="flex flex-shrink-0 items-center gap-2 ml-3">
                        {task.dependencies.length > 0 && (
                          <div className="flex gap-1">
                            {task.dependencies.map((dep, idx) => (
                              <span key={idx} className="rounded px-1.5 py-0.5 text-[10px] font-mono font-medium" style={{ background: "var(--bg-glass-hover)", color: "var(--text-tertiary)" }}>
                                #{dep}
                              </span>
                            ))}
                          </div>
                        )}
                        <span
                          className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                          style={{
                            background:
                              task.status === "completed" ? "var(--green-bg)" :
                              task.status === "in-progress" ? "var(--blue-bg)" :
                              task.status === "need-help" ? "var(--orange-bg)" :
                              task.status === "failed" ? "var(--red-bg)" : "var(--bg-glass-hover)",
                            color:
                              task.status === "completed" ? "var(--green)" :
                              task.status === "in-progress" ? "var(--blue)" :
                              task.status === "need-help" ? "var(--orange)" :
                              task.status === "failed" ? "var(--red)" : "var(--text-tertiary)",
                          }}
                        >
                          {task.status}
                        </span>
                      </div>
                    </div>
                  </motion.div>

                  <AnimatePresence mode="wait">
                    {isExpanded && task.subtasks.length > 0 && (
                      <motion.div className="relative overflow-hidden" variants={subtaskListVariants} initial="hidden" animate="visible" exit="exit" layout>
                        <div className="absolute top-0 bottom-0 left-[20px] border-l-2 border-dashed" style={{ borderColor: "var(--border-glass-strong)" }} />
                        <ul className="mt-1 mr-2 mb-1.5 ml-3 space-y-0.5">
                          {task.subtasks.map((subtask) => {
                            const subtaskKey = `${task.id}-${subtask.id}`;
                            const isSubtaskExpanded = expandedSubtasks[subtaskKey];

                            return (
                              <motion.li key={subtask.id} className="group flex flex-col py-0.5 pl-6" variants={subtaskVariants} layout>
                                <motion.div
                                  className="flex flex-1 items-center rounded-md p-1 cursor-pointer"
                                  whileHover={{ backgroundColor: "var(--bg-glass-hover)" }}
                                  onClick={() => toggleSubtaskExpansion(task.id, subtask.id)}
                                >
                                  <motion.div
                                    className="mr-2 flex-shrink-0"
                                    onClick={(e) => { e.stopPropagation(); toggleSubtaskStatus(task.id, subtask.id); }}
                                    whileTap={{ scale: 0.9 }}
                                  >
                                    {subtask.status === "completed" ? (
                                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                                    ) : subtask.status === "in-progress" ? (
                                      <CircleDotDashed className="h-3.5 w-3.5 text-blue-400" />
                                    ) : subtask.status === "need-help" ? (
                                      <CircleAlert className="h-3.5 w-3.5 text-amber-400" />
                                    ) : (
                                      <Circle className="h-3.5 w-3.5" style={{ color: "var(--text-tertiary)" }} />
                                    )}
                                  </motion.div>
                                  <span className={`text-[13px] ${subtask.status === "completed" ? "line-through opacity-50" : ""}`} style={{ color: "var(--text-secondary)" }}>
                                    {subtask.title}
                                  </span>
                                </motion.div>

                                <AnimatePresence mode="wait">
                                  {isSubtaskExpanded && (
                                    <motion.div
                                      className="mt-1 ml-1.5 border-l border-dashed pl-5 text-[12px]"
                                      style={{ borderColor: "var(--border-glass-strong)", color: "var(--text-tertiary)" }}
                                      variants={subtaskDetailsVariants}
                                      initial="hidden"
                                      animate="visible"
                                      exit="hidden"
                                      layout
                                    >
                                      <p className="py-1">{subtask.description}</p>
                                      {subtask.tools && subtask.tools.length > 0 && (
                                        <div className="mt-1 mb-1 flex flex-wrap items-center gap-1.5">
                                          <span className="font-medium" style={{ color: "var(--text-tertiary)" }}>Tools:</span>
                                          {subtask.tools.map((tool, idx) => (
                                            <span key={idx} className="rounded px-1.5 py-0.5 text-[10px] font-mono font-medium" style={{ background: "var(--accent-bg)", color: "var(--accent)" }}>
                                              {tool}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </motion.li>
                            );
                          })}
                        </ul>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.li>
              );
            })}
          </ul>
        </div>
      </LayoutGroup>
    </motion.div>
  );
}

export type { Task, Subtask };
