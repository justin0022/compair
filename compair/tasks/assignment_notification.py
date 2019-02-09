from datetime import datetime, timedelta
import pytz

from flask import current_app
from sqlalchemy import and_, or_
from compair.core import celery, db
from compair.models import Course, Assignment, User, Answer, UserCourse, \
    CourseRole, EmailNotificationMethod, \
    AssignmentNotification, AssignmentNotificationType
from compair.core import event

# We cannot import Notification from compair.notifications direct as Notification is imported as part of ComPAIR app.
# Trying to import it here will create circular import and fail.
# Instead, we use event to trigger it
on_answer_period_ending_soon = event.signal('ANSWER_PERIOD_ENDING_SOON')
on_comparison_period_ending_soon = event.signal('COMPARISON_PERIOD_ENDING_SOON')

@celery.task(bind=True, autoretry_for=(Exception,),
    ignore_result=True, store_errors_even_if_ignored=True)
def check_assignment_period_ending(self):
    now = datetime.utcnow().replace(tzinfo=pytz.utc)
    soon = now + timedelta(hours=24)  # next 24 hours

    _scan_answer_period_end(self, soon)
    _scan_comparison_period_end(self, soon)

def _scan_answer_period_end(self, end):
    current_app.logger.debug("looking for assignments with answering period ending soon...")

    # active assignments in active courses, with answer period ending soon
    assignments = Assignment.query \
        .join(Course, and_(
            Assignment.course_id==Course.id,
            Course.active==True
        )) \
        .filter(Assignment.active==True) \
        .all()
    # for those assignments in answering period
    for assignment in [a for a in assignments if a.answer_period_ending_soon(end)]:
        course = Course.query.get(assignment.course_id)

        for student in _students_in_course(course):
            if not _has_answered(assignment, student) and not _has_notified(assignment, student, AssignmentNotificationType.answer_period_end):
                if student.email_notification_method == EmailNotificationMethod.enable and student.email:
                    current_app.logger.debug("Going to remind student " + str(student.id) + " for answering assignment " + str(assignment.id))
                    on_answer_period_ending_soon.send(
                        self,
                        course=course,
                        assignment=assignment,
                        student=student)

                    _mark_notified(assignment, student, AssignmentNotificationType.answer_period_end)


def _scan_comparison_period_end(self, end):
    current_app.logger.debug("looking for assignments with comparison period ending soon...")

    # active assignments in active courses, with comparison period ending soon
    assignments = Assignment.query \
        .join(Course, and_(
            Assignment.course_id==Course.id,
            Course.active==True
        )) \
        .filter(Assignment.active==True) \
        .all()
    # for those assignments in comparison period
    for assignment in [a for a in assignments if a.comparison_period_ending_soon(end)]:
        course = Course.query.get(assignment.course_id)

        for student in _students_in_course(course):
            if not _has_compared(assignment, student) and not _has_notified(assignment, student, AssignmentNotificationType.comparison_period_end):
                if student.email_notification_method == EmailNotificationMethod.enable and student.email:
                    current_app.logger.debug("Going to remind student " + str(student.id) + " for doing comparison in assignment " + str(assignment.id))
                    on_comparison_period_ending_soon.send(
                        self,
                        course=course,
                        assignment=assignment,
                        student=student)

                    _mark_notified(assignment, student, AssignmentNotificationType.comparison_period_end)


def _students_in_course(course):
    user_courses = UserCourse.query \
        .filter_by(
            course_id=course.id,
            course_role=CourseRole.student
        ) \
        .all()
    return [uc.user for uc in user_courses]


def _has_answered(assignment, user):
    group = user.get_course_group(assignment.course_id)
    group_id = group.id if group else None

    answer_count = Answer.query \
        .filter_by(
            assignment_id=assignment.id,
            comparable=True,
            active=True,
            practice=False,
            draft=False
        ) \
        .filter(or_(
            Answer.user_id == user.id,
            and_(Answer.group_id == group_id, Answer.group_id != None)
        )) \
        .count()
    return answer_count > 0


def _has_compared(assignment, user):
    return assignment.completed_comparison_count_for_user(user.id) >= assignment.total_comparisons_required


def _has_notified(assignment, user, notification_type):
    notify_count = AssignmentNotification.query \
        .filter_by(
            assignment_id = assignment.id,
            user_id = user.id,
            notification_type = notification_type.value
        ) \
        .count()
    return notify_count > 0


def _mark_notified(assignment, user, notification_type):
    assignment_notification = AssignmentNotification(
        assignment_id = assignment.id,
        user_id = user.id,
        notification_type = notification_type.value
    )
    db.session.add(assignment_notification)
    db.session.commit()
