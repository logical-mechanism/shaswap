//! Run the synthetic order-book harness across a sweep of batch sizes and print
//! the netting / surplus numbers — the economic measurement, no chain needed.
//!
//! `cargo run -p solver-core --example sim_sweep`

use solver_core::sim::{run_scenario, Scenario};

fn main() {
    println!(
        "{:>5}  {:>9}  {:>8}  {:>11}  {:>9}",
        "N", "included", "netting", "surplus_a", "solved"
    );
    println!("{}", "-".repeat(52));
    for &n in &[1usize, 2, 5, 10, 20, 30, 44] {
        // average a handful of seeds per size for a stable picture.
        let (mut net_sum, mut incl_sum, mut surplus_sum, mut solved_cnt) = (0.0, 0usize, 0i128, 0);
        let seeds = 16u64;
        for seed in 0..seeds {
            let rep = run_scenario(&Scenario::balanced(seed, n));
            if rep.solved {
                net_sum += rep.netting_rate;
                incl_sum += rep.n_included;
                surplus_sum += rep.surplus_a_equiv;
                solved_cnt += 1;
            }
        }
        let denom = solved_cnt.max(1) as f64;
        println!(
            "{:>5}  {:>9.1}  {:>7.1}%  {:>11}  {:>4}/{}",
            n,
            incl_sum as f64 / denom,
            100.0 * net_sum / denom,
            surplus_sum / solved_cnt.max(1) as i128,
            solved_cnt,
            seeds,
        );
    }
    println!(
        "\nnetting% = fraction of asset_a flow cleared user-to-user (CoW) vs through the pool.\n\
         surplus_a = mean per-batch surplus vs each order swapping solo against the pool\n\
         (negative on one-sided/imbalanced books — batching same-direction orders concentrates\n\
         price impact; the win is opposing orders that net). v1 is floor-only (valid, not optimal)."
    );
}
