package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.hardware.DcMotorEx;
import com.qualcomm.hardware.rev.RevHubOrientationOnRobot;
import com.qualcomm.robotcore.hardware.IMU;

@Autonomous(name = "LiftAuto")
public class LiftAuto extends LinearOpMode {
    @Override
    public void runOpMode() {
        DcMotorEx liftL = hardwareMap.get(DcMotorEx.class, "lift_left");
        DcMotorEx liftR = hardwareMap.get(DcMotorEx.class, "lift_right");
        IMU imu = hardwareMap.get(IMU.class, "imu");
        // "hang_motor" was removed from the robot last week — config never knew it,
        // and this reference now points at nothing.
        DcMotorEx hang = hardwareMap.tryGet(DcMotorEx.class, "hang_motor");

        waitForStart();
    }
}
