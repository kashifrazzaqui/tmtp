import { createRoot } from "react-dom/client";
import { App } from "./ui/App.js";
import "./ui/styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("The application root is missing.");

createRoot(container).render(<App />);
