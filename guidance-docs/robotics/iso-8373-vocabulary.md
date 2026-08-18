# ISO 8373:2021 — Robotics Vocabulary

> **Kuhn knowledge card.** Canonical source: https://www.iso.org/standard/75539.html (International Organization for Standardization). Source access/license: paywalled standard (~$250 USD); free preview/abstract on the ISO site. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

ISO 8373:2021 (Edition 3, November 2021) is the master terminology standard for robotics.
It defines the vocabulary used across all other ISO robotics standards (safety, performance,
collaborative operation) and covers mechanical structure, kinematics, geometry, programming
and control, performance characteristics, sensing, and navigation. It applies to both
industrial and non-industrial (service, medical, personal-care) robots. Any robotics
manuscript, specification, regulatory submission, or technical report benefits from using
its terms consistently, because reviewers and standards bodies treat ISO 8373 definitions
as the reference meaning. The standard itself is paywalled; this card is the searchable
working substitute for writers.

## Key requirements

The standard is definitional rather than prescriptive; the "requirement" for writers is
consistent use of its terms. Paraphrased core definitions:

- **Robot** — a programmed actuated mechanism with a degree of autonomy that moves within
  its environment to perform intended tasks. Two elements are essential: programmability
  (behaviour can be changed without physical modification) and autonomy. Devices lacking
  a degree of autonomy (e.g., purely teleoperated mechanisms) are not robots under this
  definition.
- **Autonomy** — the ability to perform intended tasks based on current state and sensing,
  without human intervention. The 2021 edition treats autonomy as a matter of degree
  ("degree of autonomy"), not a binary property; fully teleoperated through fully
  autonomous is a spectrum.
- **Industrial robot** — an automatically controlled, reprogrammable, multipurpose
  manipulator, programmable in three or more axes, fixed in place or mobile, for use in
  industrial automation. The three-or-more-axes and reprogrammability clauses distinguish
  industrial robots from fixed automation.
- **Service robot** — a robot that performs useful tasks for humans or equipment, defined
  in the 2021 edition by application (not residually as "non-industrial"); split into
  personal service robots (domestic/consumer use) and professional service robots
  (commercial tasks, trained operators).
- **Medical robot** — a robot intended for use as medical electrical equipment or a medical
  device; carved out as its own category in the 2021 revision (previously folded into
  service robots).
- **Manipulator** — a machine whose mechanism is a series of segments (links), jointed or
  sliding relative to one another, for grasping or moving objects in several degrees of
  freedom. A manipulator alone is not a robot; a robot comprises manipulator plus control
  system.
- **End-effector** — the device attached to the mechanical interface at the end of the
  manipulator (gripper, tool, welding gun) by which the robot acts on its environment.
  Distinguish from **end-of-arm tooling**, the broader assembly that may include sensors
  and tool changers.
- **Robotic device** — an actuated mechanism sharing characteristics with robots but
  lacking either the required programmability or the degree of autonomy (e.g., some
  exoskeleton configurations, teleoperated devices).
- **Robot system** — the combination of robot(s), end-effector(s), and any machinery,
  equipment, sensors, or communication interfaces required to perform the task.
- **Collaborative operation** — a state in which a purpose-designed robot system works in
  direct cooperation with a human within a defined shared **collaborative workspace**.
  The 2021 edition frames collaboration as an *operation mode*, not a robot type —
  "collaborative robot" as a product category is informal usage.
- **Mobile robot / mobile platform** — a robot able to travel under its own control; the
  mobile platform is the locomotion assembly without manipulators.
- **AMR vs AGV** — an autonomous mobile robot navigates using its own sensing and
  planning; an automated guided vehicle follows predefined paths or external guidance.
- **Kinematics and performance terms** with fixed meanings: axis/joint; degrees of
  freedom; **pose** (position + orientation combined); workspace/working space;
  **pose accuracy** (agreement between commanded and attained pose) vs **pose
  repeatability** (scatter among repeated attained poses); path accuracy; payload and
  rated load; operating modes (manual, automatic); teach pendant; task program vs
  control program.

## How to apply when writing

- Use ISO 8373 senses on first use of contested terms; when a paper's usage diverges
  (common in ML-robotics, where "robot" and "autonomy" are used loosely), state the
  working definition explicitly and cite ISO 8373:2021.
- Never use *accuracy* and *repeatability* interchangeably in performance reporting;
  pair them with ISO 9283 test conditions when reporting manipulator performance.
- Write *pose* when you mean position + orientation together; write *position* only for
  translation.
- Distinguish the *robot* (mechanism + control) from the *robot system* (robot +
  end-effector + peripherals) — safety and performance claims usually attach to the system.
- Say "robot system designed for collaborative operation" rather than treating "cobot"
  as a standardized class; anchor informal "cobot" usage to the standard's framing once.
- Classify platforms precisely: AMR vs AGV, mobile platform vs mobile robot, manipulator
  vs robot.
- In methods sections, report degrees of freedom, rated payload, and workspace using
  these terms so descriptions map onto datasheet and standards language.

## Common pitfalls

- Calling a teleoperated or fully scripted device a "robot" without noting the
  degree-of-autonomy criterion, then facing reviewer pushback on autonomy claims.
- Using "collaborative robot" as if it were an ISO-defined robot category; the standard
  defines collaborative *operation*.
- Conflating end-effector with end-of-arm tooling, or manipulator with the whole robot.
- Reporting "accuracy" figures that are actually repeatability measurements.
- Mixing 2012 and 2021 edition terminology (the 2021 edition restructured service/medical
  robot definitions and the autonomy framing); cite the edition year.
- Treating "AGV" and "AMR" as synonyms in navigation papers.

## Canonical links

- https://www.iso.org/standard/75539.html — ISO 8373:2021 official page (purchase + preview)
- https://www.iso.org/obp/ui/#iso:std:iso:8373:ed-3:v1:en — ISO Online Browsing Platform preview
- https://www.iso.org/committee/5915511.html — ISO/TC 299 Robotics (owning technical committee)
