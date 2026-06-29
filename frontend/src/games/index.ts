// Import each game module for its register() side-effect. The registration
// order here is the order windows open and tile on the desktop. Add new games
// here (one folder per game so each owner ships theirs independently).
import "./blackjack";
import "./chickenCross";
import "./bombIt";
import "./quantumPoker";
import "./ticTacToe";
import "./battleship";
import "./worldCanvas";
import "./chat";
// Floating-widget modules (catalog: false) — registered for rendering but kept out
// of the catalog; the desktop opens them centered in the default/reset layout.
import "./chat";
import "./regularPayments";
// Hidden for now — re-enable by uncommenting.
// import "./agentAllowance";
// import "./streamingPayment";
// import "./apiCredits";
// import "./coinFlip";
// import "./dice";
// import "./slots";
